// What's going on, for the owner's own clients, read from what's there: rules, cards, runs and who has been seen. Nothing
// is decided by it, so it's no part of the kernel.
import type { SQLInputValue } from "node:sqlite";
import { describeCron, dayStart, nextRun, parseCron } from "../kernel/cron.ts";
import { SEEN_EVERY } from "../kernel/due.ts";
import { iso, type Row, type View } from "../kernel/evolve.ts";
import type { cardView } from "../kernel/query.ts";
import { cronOf, eventRule, SCHEDULE, type Rules } from "../kernel/rules.ts";
import { stagesOf } from "../kernel/stage.ts";

/** The columns of the read-only SQL views over the projections, which the queries here read. */
const VIEWS = {
  events:
    "id source key type subject summary detail link actor reply matched routed dispatched paused refused dispatch_run dispatch_state dispatch_project received_at",
  runs:
    "id rule agent grp lane state attempts not_before claim last_result cancel_at resume session link created_at " +
    "claimed_at seen_at finished_at manual summary error usage report",
  run_events: "run_id event_id context",
  run_progress: "id run_id at step detail kind",
  cards:
    "id key kind title text options recommend about state fyi quiet choice answer by result rule lane grp source " +
    "agent session run_id answer_event version created_at decided_at closed_at reply",
  deliveries: "card_id channel version ref tries first_try_at not_before error given_up",
  decisions: "id event_id rule source actor state reason strength scope rules_version decided_at",
  dispatch_decisions:
    "id event_id dispatch_run source actor snapshot_version candidates project session confidence reason outcome created_at",
  dispatch_corrections: "id event_id suggested chosen source actor lane reason created_at",
  dispatch_preferences: "id project source actor reason confirmations active created_at updated_at",
  project_creations:
    "id event_id dispatch_run source event_type actor project description cwd agent worker subjects confidence state reason created_at applied_at error",
  mandates: "event_id rule strength reason scope rules_version granted_at",
  timers: "id rule lane key source agent session about at event_id reply created_at",
  schedules: "rule cron next_at skipped_at",
  seen: "kind name seen_at",
  keys: "kind name hash created_at",
  pauses: "name by reason since until",
};

/** Made anew at every start, so changing them takes no rebuild and no migration. */
export const viewStatements = Object.entries(VIEWS).map(([table, columns]) => {
  const selected = columns.split(" ").map((column) => `json_extract(data,'$.${column}') AS ${column}`);
  return `DROP VIEW IF EXISTS ${table}; CREATE VIEW ${table} AS SELECT ${selected.join(",")} FROM projections WHERE collection='${table}'`;
});

/** Seen this recently counts as online: two minutes of quiet, by a stamp that can be behind by SEEN_EVERY. */
const ONLINE = 120_000 + SEEN_EVERY;
const PAGE = 60;
const WEEK = 7 * 86400_000;

export type Spending = {
  rounds: number;
  tokens: number;
  cached: number;
  cost: number;
  missingTokens: number;
  missingCost: number;
};
const SPENDING = `SELECT COUNT(*) AS rounds,
  COALESCE(SUM(COALESCE(json_extract(usage, '$.input'), 0) + COALESCE(json_extract(usage, '$.output'), 0)), 0) AS tokens,
  COALESCE(SUM(json_extract(usage, '$.cached')), 0) AS cached,
  COALESCE(SUM(json_extract(usage, '$.cost')), 0) AS cost,
  COUNT(*) - COUNT(COALESCE(json_extract(usage, '$.input'), json_extract(usage, '$.output'))) AS missingTokens,
  COUNT(*) - COUNT(json_extract(usage, '$.cost')) AS missingCost
  FROM runs WHERE finished_at >= ? AND (claimed_at IS NOT NULL OR usage IS NOT NULL)`;

const COUNTS = `
  SELECT rule, agent, state, COUNT(*) AS count,
    SUM(CASE WHEN state = 'queued' AND attempts > 0 THEN 1 ELSE 0 END) AS retrying,
    SUM(CASE WHEN state = 'done' AND finished_at >= ? THEN 1 ELSE 0 END) AS today,
    COALESCE(SUM(json_extract(usage, '$.input')), 0) AS input,
    COALESCE(SUM(json_extract(usage, '$.output')), 0) AS output,
    COALESCE(SUM(json_extract(usage, '$.cost')), 0) AS cost
  FROM runs GROUP BY rule, agent, state`;

// Start from this run's links; scanning events in ID order would revisit the whole history for each run.
const EVENTS_OF_RUN = `
  SELECT source, type, subject, summary, link FROM run_events CROSS JOIN events ON events.id = run_events.event_id
  WHERE run_events.run_id = ? ORDER BY events.id DESC LIMIT 20`;

type Reads = {
  all: <T>(sql: string, params?: SQLInputValue[]) => T[];
  view: (card: Row) => ReturnType<typeof cardView>;
  /** The kernel's own projection, for what the SQL views can't answer (the stage of a matter). */
  state: View;
  unrouted: () => Row[];
};

const sum = (counted: Row[], field: string): number => counted.reduce((total, row) => total + row[field], 0);

export function spendingOf(all: Reads["all"], now: number, timezone: string) {
  const since = (time: number) => all<Spending>(SPENDING, [iso(time)])[0];
  return { today: since(dayStart(now, timezone)), week: since(now - WEEK) };
}

function tally(counted: Row[]) {
  const inState = (state: string) => counted.reduce((total, row) => total + (row.state === state ? row.count : 0), 0);
  return {
    running: inState("claimed"),
    queued: inState("queued"),
    retrying: sum(counted, "retrying"),
    unknown: inState("unknown"),
    done: inState("done"),
    doneToday: sum(counted, "today"),
    nothing: inState("nothing"),
    usage: { input: sum(counted, "input"), output: sum(counted, "output"), cost: sum(counted, "cost") },
  };
}

// Events a pause kept from a rule: only those carry the field. A range on it, and +id, keep to that index instead of
// walking every event by id.
const SKIPPED = `SELECT id, source, type, subject, summary, paused, received_at FROM events
  WHERE paused > '' ORDER BY +id DESC LIMIT 20`;
// The same, for one rule since its pause began, less those a replay has since handed to a run of the rule.
const SKIPPED_BY = `FROM events WHERE paused > '' AND received_at >= ?
  AND EXISTS (SELECT 1 FROM json_each(paused) WHERE value = ?)
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(refused, '[]')) WHERE value = ?)
  AND NOT EXISTS (SELECT 1 FROM run_events JOIN runs ON runs.id = run_events.run_id
    WHERE run_events.event_id = events.id AND runs.rule = ? AND COALESCE(run_events.context, 0) = 0)`;
/** How many of the events a pause skipped come listed with it; the count says how many there are in all. */
const LISTED = 20;

const skippedView = ({ paused, received_at: receivedAt, ...event }: Row) => ({
  ...event,
  receivedAt,
  rules: JSON.parse(paused),
});

/**
 * What a pause has kept from a rule since `since` and nothing has made up yet, newest first: how many, and the latest of
 * them, or all of them.
 */
export function skippedOf(all: Reads["all"], rule: string, since: string, everything = false) {
  const { count } = all<{ count: number }>(`SELECT COUNT(*) AS count ${SKIPPED_BY}`, [since, rule, rule, rule])[0];
  const columns = "SELECT id, source, type, subject, summary, paused, received_at";
  const order = `ORDER BY +id DESC${everything ? "" : ` LIMIT ${LISTED}`}`;
  const events = all<Row>(`${columns} ${SKIPPED_BY} ${order}`, [since, rule, rule, rule]);
  return { count, events: events.map(skippedView) };
}

export function stateOf(now: number, before: number | undefined, rules: Rules, { all, view, state, unrouted }: Reads) {
  const seen = new Map(
    all<Row>("SELECT kind, name, seen_at FROM seen").map((row) => [`${row.kind}:${row.name}`, row.seen_at as string]),
  );
  const presence = (who: string) => {
    const seenAt = seen.get(who) ?? null;
    return { seenAt, online: seenAt !== null && now - Date.parse(seenAt) <= ONLINE };
  };
  const counts = all<Row>(COUNTS, [iso(dayStart(now, rules.timezone))]);
  const dispatchRows = all<Row>(
    "SELECT id, source, type, subject, summary, dispatch_state, dispatch_project, received_at FROM events WHERE dispatch_state IN ('queued', 'running', 'creating') ORDER BY +id DESC LIMIT 20",
  );
  const openCards = all<Row>("SELECT * FROM cards WHERE state = 'open' ORDER BY id DESC");
  const recentCards = all<Row>("SELECT * FROM cards WHERE state <> 'open' ORDER BY id DESC LIMIT 20");
  const timers = before
    ? []
    : all<Row>("SELECT rule, lane, key, about, at FROM timers WHERE event_id IS NULL ORDER BY at");
  const older = before ? "WHERE id < ?" : "";
  const page = all<Row>(
    `SELECT * FROM runs ${older} ORDER BY id DESC LIMIT ?`,
    before ? [before, PAGE + 1] : [PAGE + 1],
  );
  const active = before ? [] : all<Row>("SELECT * FROM runs WHERE state IN ('queued', 'claimed', 'unknown')");
  const hasMore = page.length > PAGE;
  const byId = new Map([...page.slice(0, PAGE), ...active].map((run) => [run.id, run]));
  const visible = [...byId.values()].sort((a, b) => b.id - a.id);
  const progress = new Map<number, Row[]>();
  if (visible.length) {
    const ids = visible.map((run) => Number(run.id));
    const placeholders = ids.map(() => "?").join(",");
    for (const row of all<Row>(`SELECT * FROM run_progress WHERE run_id IN (${placeholders}) ORDER BY id DESC`, ids)) {
      const list = progress.get(Number(row.run_id)) ?? [];
      if (list.length < 20) list.push(row);
      progress.set(Number(row.run_id), list);
    }
  }
  // A pause past its end is lifted at the next tick; until then it already doesn't hold. A schedule lets its moments pass
  // and keeps no events.
  const timed = new Set(rules.rules.filter((rule) => !eventRule(rule)).map((rule) => rule.name));
  const pauses = all<Row>("SELECT name, by, reason, since, until FROM pauses ORDER BY name")
    .filter((pause) => pause.until === null || Date.parse(pause.until) > now)
    .map((pause): Row => ({
      ...pause,
      skipped: timed.has(pause.name) ? null : skippedOf(all, pause.name, pause.since),
    }));
  const pauseOf = (rule: Rules["rules"][number]) => {
    const pause = pauses.find((p) => p.name === rule.name);
    if (!pause) return null;
    const { by, reason, since, until, skipped } = pause;
    return { by, reason, since, until, skipped };
  };
  const skippedAt = new Map(
    all<Row>("SELECT rule, skipped_at FROM schedules").map((row) => [row.rule, row.skipped_at]),
  );
  return {
    now: iso(now),
    timezone: rules.timezone,
    spending: spendingOf(all, now, rules.timezone),
    totals: { ...tally(counts), attention: openCards.length, dispatching: dispatchRows.length },
    // The owner's own: which matter a card is about, and what its asker left for whoever carries on. Channels don't get them.
    cards: openCards.map((card) => ({ ...view(card), lane: card.lane, about: card.about })),
    recentCards: recentCards.map((card) => ({ ...view(card), lane: card.lane, about: card.about })),
    timers: timers.map(({ rule, lane, key, about, at }) => ({ rule, lane, key, about, at })),
    sources: Object.entries(rules.sources).map(([id, { name }]) => {
      const events = all<Row>("SELECT COUNT(*) AS n FROM events WHERE source = ?", [id])[0].n as number;
      return { id, name, events };
    }),
    lines: rules.rules.map((rule) => ({
      id: rule.name,
      name: rule.name,
      group: rule.group,
      ...(rule.project && { project: rule.project }),
      agent: rule.to,
      source: eventRule(rule) ? rule.when.source : SCHEDULE,
      types: eventRule(rule) ? rule.when.types : [],
      every: eventRule(rule) ? null : describeCron(cronOf(rule)),
      next: eventRule(rule) ? null : iso(nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!),
      totals: tally(counts.filter((row) => row.rule === rule.name)),
      paused: pauseOf(rule),
      skippedAt: eventRule(rule) ? null : (skippedAt.get(rule.name) ?? null),
    })),
    pauses,
    skipped: all<Row>(SKIPPED).map(skippedView),
    elsewhere: rules.elsewhere.map(({ name, source, to, cron, where, model, effort }) => {
      const next = iso(nextRun(parseCron(cron)!, now, rules.timezone) ?? now);
      const shown = { id: name, name, source, agent: to, cron, every: describeCron(cron), next, where };
      return { ...shown, ...(model && { model }), ...(effort && { effort }) };
    }),
    agents: Object.entries(rules.agents).map(([id, { name, use, worker, program }]) => {
      const totals = tally(counts.filter((row) => row.agent === id));
      return { id, name, use, worker, ...(program && { program }), ...presence(`worker:${worker}`), totals };
    }),
    channels: Object.entries(rules.channels).map(([id, { name }]) => ({ id, name, ...presence(`channel:${id}`) })),
    runs: visible.map((run) => ({
      id: run.id as number,
      rule: run.rule,
      agent: run.agent,
      state: run.state,
      attempts: run.attempts,
      createdAt: run.created_at,
      claimedAt: run.claimed_at,
      finishedAt: run.finished_at,
      notBefore: run.not_before,
      summary: run.summary ?? "",
      error: run.error ?? "",
      link: run.link ?? "",
      session: run.session,
      usage: run.usage ? JSON.parse(run.usage) : null,
      report: run.report ? JSON.parse(run.report) : null,
      stopping: run.cancel_at !== null,
      manual: Boolean(run.manual),
      progress: (progress.get(Number(run.id)) ?? []).reverse(),
      events: all<Row>(EVENTS_OF_RUN, [run.id]),
    })),
    // What each open matter is waiting for, so a board can put the ones needing a person first.
    matters: stagesOf(state, rules, now),
    // What a policy decided, and what it granted: read-only, for looking back at why work started or didn't. These are
    // the latest overall, like the open cards, not part of the run page: paging older runs must not hide them.
    decisions: all<Row>("SELECT * FROM decisions ORDER BY id DESC LIMIT 50"),
    dispatchDecisions: all<Row>("SELECT * FROM dispatch_decisions ORDER BY id DESC LIMIT 50"),
    dispatchCorrections: all<Row>("SELECT * FROM dispatch_corrections ORDER BY id DESC LIMIT 50"),
    dispatchPreferences: all<Row>("SELECT * FROM dispatch_preferences ORDER BY id DESC LIMIT 50"),
    projectCreations: all<Row>("SELECT * FROM project_creations ORDER BY id DESC LIMIT 50"),
    dispatching: dispatchRows.map(
      ({ dispatch_state: state, dispatch_project: project, received_at: receivedAt, ...event }) => ({
        ...event,
        state,
        ...(project && { project }),
        receivedAt,
      }),
    ),
    mandates: all<Row>("SELECT * FROM mandates ORDER BY granted_at DESC LIMIT 50"),
    hasMore,
    nextBefore: hasMore ? page[PAGE - 1].id : null,
    unrouted: unrouted(),
  };
}
