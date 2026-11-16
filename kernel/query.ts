// Reading the view: what the decisions and the doors ask of it, and the shapes they hand out.
import { credential, type Environment } from "./credentials.ts";
import { rows, type Fact, type Row, type View } from "./evolve.ts";
import { DISPATCH_NAME, eventRule, ruleOf, typeMatches, type Rule, type Rules } from "./rules.ts";
import { stageOf, stagesOf } from "./stage.ts";
import type { Job } from "../protocol/job.ts";

/** Seen this recently counts as online; the same window the state board uses. */
const ONLINE = 120_000 + 60_000;

/** Whether a worker has checked in recently enough for the hub to place work on it. */
export function workerOnline(view: View, worker: string, now: number): boolean {
  const seen = view.get("seen", `worker:${worker}`);
  return !!seen && now - Date.parse(seen.seen_at) <= ONLINE;
}

export function configuration(view: View, version?: number): Rules {
  const current = view.get("config", "rules");
  return (version === undefined || version === current?.version ? current : view.get("config", version))?.value;
}
/** The owner's pause that keeps a rule from taking work at this moment, if there is one. */
export function pauseOf(view: View, rule: Rule, now: number): Row | null {
  const row = view.get("pauses", rule.name);
  return row && (row.until === null || Date.parse(row.until) > now) ? row : null;
}

export const workerOf = (view: View, run: Row) => configuration(view, run.rules_version).agents[run.agent]?.worker;
export function agentsOf(view: View, worker: string) {
  const agents = Object.entries(configuration(view).agents);
  return agents.filter(([, agent]) => agent.worker === worker).map(([id]) => id);
}
export const workers = (view: View) =>
  new Set([
    ...Object.values(configuration(view)?.agents ?? {}).map((agent) => agent.worker),
    ...rows(view, "runs", { state: "claimed" }).map((run) => workerOf(view, run)!),
  ]);

/** What a worker's agents have on: runs in hand and runs ready to be claimed. */
export function waitingOn(view: View, worker: string, now: number) {
  return rows(view, "runs", { state: ["queued", "claimed"] }).filter(
    (run) => workerOf(view, run) === worker && (run.state === "claimed" || Date.parse(run.not_before) <= now),
  );
}

/** Every event a round read, including fan-out context. This is what the Agent gets to read. */
export function eventsOf(view: View, runId: number) {
  const links = rows(view, "run_events", { run_id: runId });
  return links.map((link) => view.get("events", link.event_id)!).sort((a, b) => a.id - b.id);
}

/** The events a round actually took for its rule, leaving out context added by fan-out. */
export function takenEventsOf(view: View, runId: number) {
  const links = rows(view, "run_events", { run_id: runId });
  return links
    .filter((link) => !link.context)
    .map((link) => view.get("events", link.event_id)!)
    .sort((a, b) => a.id - b.id);
}

/** The source a round is about: one source among the events it took, never context from another rule's matter. */
export function sourceOf(view: View, runId: number) {
  const sources = [...new Set(takenEventsOf(view, runId).map((event) => event.source))];
  return sources.length === 1 ? sources[0] : null;
}

/** The rules an event went to, and the ones that would have taken it but were paused. */
export function routingOf(event: Row) {
  const paused: string[] = JSON.parse(event.paused ?? "[]");
  const refused: string[] = JSON.parse(event.refused ?? "[]");
  // Older facts have no `dispatched`: before it existed, `routed` was the match list. `matched` is the current field.
  const dispatched: string[] = JSON.parse(event.dispatched ?? "null") ?? JSON.parse(event.routed);
  const routed = dispatched.filter((name: string) => !paused.includes(name) && !refused.includes(name));
  return { routed, paused, ...(refused.length && { refused }) };
}

/** How a dispatcher has handled an event so far. A queued or running dispatch is pending, not unrouted. */
export function dispatchOf(event: Row) {
  const state = event.dispatch_state as string | undefined;
  if (!state) return {};
  return {
    dispatch: {
      state,
      ...(event.dispatch_run !== undefined && event.dispatch_run !== null && { run: event.dispatch_run }),
      ...(event.dispatch_project && { project: event.dispatch_project }),
    },
    ...((state === "queued" || state === "running" || state === "creating") && { pending: true }),
  };
}

/**
 * What became of an event, for the source that sent it: every run it is in now, as retries can merge runs. A run's summary
 * and the events its receipt sent are what the Agent made of all its events, so only a run of this source's alone has them.
 */
export function eventOutcome(view: View, source: string, id: number) {
  const event = view.get("events", id);
  if (event?.source !== source || !event.sent) return null;
  // A run that only read this event as fan-out context is not an outcome of it.
  const runs = rows(view, "run_events", { event_id: id })
    .filter((link) => !link.context)
    .map((link) => view.get("runs", link.run_id)!)
    .sort((a, b) => a.id - b.id);
  return {
    event: event.id,
    ...routingOf(event),
    ...(dispatchOf(event) as { dispatch?: Row; pending?: boolean }),
    runs: runs.map((run) => {
      const own = sourceOf(view, run.id) === source;
      const sent = (JSON.parse(run.emitted ?? "[]") as number[]).map((id) => view.get("events", id)!);
      return {
        run: run.id,
        rule: run.rule,
        state: run.state,
        attempts: run.attempts,
        error: run.error,
        finishedAt: run.finished_at,
        summary: own ? run.summary : null,
        events: own
          ? sent.map(({ key: id, type, subject, summary, detail, link }) => ({
              id,
              type,
              subject,
              summary,
              detail,
              link,
            }))
          : null,
      };
    }),
  };
}

/** The cards a run may close: open before it was claimed, from the same source and group. */
export function openInScope(view: View, run: Row) {
  const source = sourceOf(view, run.id);
  if (!source || !run.claimed_at) return [];
  return rows(view, "cards", { state: "open", grp: run.grp, source }).filter(
    (card) => card.created_at <= run.claimed_at,
  );
}

export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  const { id, version, kind, state, title, text, recommend, choice, answer, by, result, reply, lane, fyi } = card;
  const options: string[] = kind === "ask" ? JSON.parse(card.options) : state === "open" ? ["已处理"] : [];
  const link = links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", id, card.created_at)}` : null;
  const when = { createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at };
  return {
    id,
    version,
    ref,
    kind,
    state,
    title,
    text,
    options,
    recommend,
    choice,
    answer,
    by,
    result,
    link,
    rule: card.rule,
    ...(lane && { lane }),
    ...(reply && { reply }),
    ...(fyi ? { fyi: true } : {}),
    ...when,
  };
}

/** The style of the place a rule's messages land: its own channels' first stated one, else the default channels'. */
function styleOf(rules: Rules, rule: Rule): "im" | "async" | undefined {
  const names = rule.channels ?? rules.defaultChannels ?? Object.keys(rules.channels);
  for (const name of names) {
    const style = rules.channels[name]?.style;
    if (style) return style;
  }
  return undefined;
}

/** The stable name of a matter: rule and lane, which is what a later round or a related rule can name. */
export const threadId = (rule: string, lane: string) => `${rule}:${lane}`;

/** What an agent can recall by hops: its own matter, its past rounds, and other live matters on the same subject. */
function threadOf(view: View, rules: Rules, run: Row, now: number): NonNullable<Job["thread"]> {
  const rounds = rows(view, "runs", { rule: run.rule, lane: run.lane }, 10, true).map((other) => ({
    run: other.id,
    state: other.state,
    summary: other.summary ?? "",
    at: other.finished_at ?? null,
  }));
  const related = run.lane
    ? rows(view, "runs", { lane: run.lane, state: ["queued", "claimed"] })
        .filter((other) => other.rule !== run.rule)
        .map((other) => ({
          rule: other.rule,
          lane: other.lane,
          stage: stageOf(view, rules, other.rule, other.lane, now),
        }))
    : [];
  const definition = ruleOf(rules, run.rule);
  return {
    id: threadId(run.rule, run.lane),
    rule: run.rule,
    lane: run.lane,
    ...(definition?.project && { project: definition.project }),
    rounds,
    related,
  };
}

export function jobOf(view: View, run: Row, env: Environment, now = Date.parse(run.created_at)): Job {
  const rules = configuration(view, run.rules_version);
  // A dispatcher round is not a rule's work even if a rule happens to use the internal name.
  const definition = run.kind === "dispatch" ? undefined : ruleOf(rules, run.rule);
  // A dispatch round names no real matter: its own thread would only offer a made-up rule and lane back to the model.
  const runThread = run.kind === "dispatch" ? undefined : threadOf(view, rules, run, now);
  // A dispatcher is not a rule's work: it needs a place to read from and a name, but no rule prompt or cwd.
  const { name, cwd, skill, prompt, title, emits } = definition ?? {
    name: run.kind === "dispatch" ? DISPATCH_NAME : run.rule,
    // A dispatch has no rule and no project folder. It still needs a real, harmless place to start from: the worker
    // expands `~` and refuses a missing directory, so an empty cwd would fail before the read-only round begins.
    cwd: "~",
    skill: undefined,
    prompt: undefined,
    title: undefined,
    emits: undefined,
  };
  const { maxActive: _maxActive, ...agent } = rules.agents[run.agent];
  // An assessor reads and judges; a speculative try rehearses. Neither may change files or reach the outside world.
  const access = run.kind ? "read" : agent.access;
  const events = eventsOf(view, run.id);
  const takenIds = takenEventsOf(view, run.id).map((event) => event.id);
  const thread = { rule: run.rule, lane: run.lane };
  const answers = rows(view, "cards", { ...thread, answer_event: takenIds });
  const timers = rows(view, "timers", { ...thread, event_id: takenIds });
  const waiting = rows(view, "timers", { ...thread, event_id: null });
  const decided = ["decided", "done"]
    .flatMap((state) => rows(view, "cards", { ...thread, state }, 20, true))
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  const timerView = (timer: Row) => ({ key: timer.key, about: timer.about, at: timer.at });
  return {
    run: run.id,
    token: credential(env, "run", run.id, run.issued),
    attempt: run.attempts + 1,
    ...(run.kind && { kind: run.kind }),
    rule: { name, cwd, skill, prompt, title, emits },
    ...(definition && styleOf(rules, definition) && { style: styleOf(rules, definition) }),
    agent: { ...agent, id: run.agent, access },
    session: run.session ?? run.resume,
    askFirst: rules.askFirst,
    ...(runThread && { thread: runThread }),
    context: {
      events: events.map(
        ({ key: id, source, type, subject, summary, detail, link, received_at: receivedAt, hops, attachments }) => {
          const sourceName = rules.sources[source]?.name ?? source;
          return {
            id,
            source,
            sourceName,
            type,
            subject,
            summary,
            detail,
            link,
            receivedAt,
            hops: hops ?? 0,
            ...(attachments && { attachments }),
          };
        },
      ),
      answers: answers.map(({ id: card, title, options, choice, answer: text, about, by, decided_at: at }) => {
        const picked: string[] = JSON.parse(options);
        return {
          card,
          title,
          options: picked,
          choice,
          chosen: choice === null ? text : picked[choice],
          text,
          about,
          by,
          at,
        };
      }),
      timers: timers.map(timerView),
      waiting: waiting.sort((a, b) => a.at.localeCompare(b.at)).map(timerView),
      open: openInScope(view, run).map(({ id, title, text, created_at }) => ({
        card: id,
        title,
        text,
        at: created_at,
      })),
      decided: decided
        .filter((card) => !answers.some((answer) => answer.id === card.id))
        .map(({ id, title, choice, answer, options, decided_at }) => {
          return { card: id, title, choice: choice === null ? answer : JSON.parse(options)[choice], at: decided_at };
        }),
      ...(run.kind === "dispatch" && {
        dispatch: dispatchSnapshot(view, rules, sourceOf(view, run.id) ?? "", events[0]?.type ?? "", now),
      }),
    },
  };
}

export function cancels(view: View, worker: string): number[] {
  return rows(view, "runs", { state: "claimed" })
    .filter((run) => run.cancel_at !== null && workerOf(view, run) === worker)
    .map((run) => run.id);
}

export function unrouted(view: View, limit = 20) {
  // Older facts have no `matched`: their `routed` is the only record of what the rules matched.
  return [
    ...rows(view, "events", { matched: "[]" }, limit, true),
    ...rows(view, "events", {}, limit, true).filter(
      (event) => event.matched === undefined && (event.routed ?? "[]") === "[]",
    ),
  ]
    .filter((event) => !event.dispatch_state)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

/**
 * What a dispatcher may choose from, read from the hub's own facts: projects are rules with a `project`, their node comes
 * from the agent, and a project is offered only when its rule is an event rule that this source and type can reach. The
 * model never remembers a node or a project: it reads this snapshot for one round.
 */
export function dispatchSnapshot(view: View, rules: Rules, source: string, type: string, now: number) {
  const projects = rules.rules
    .filter(
      (rule): rule is Rule & { project: string; when: { source: string; types: string[]; subjects?: string[] } } =>
        !!rule.project && eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, type),
    )
    .map((rule) => {
      const agent = rules.agents[rule.to];
      const [last] = rows(view, "runs", { rule: rule.name, state: ["done", "nothing"] }, 1, true);
      const [lastChoice] = rows(view, "dispatch_decisions", { project: rule.project, outcome: "placed" }, 1, true);
      const preferences = rows(view, "dispatch_preferences", { project: rule.project, active: 1 }).map((one) => ({
        source: one.source ?? "",
        actor: one.actor ?? "",
        reason: one.reason ?? "",
        confirmations: one.confirmations ?? 0,
      }));
      return {
        project: rule.project!,
        rule: rule.name,
        description: rule.description ?? "",
        cwd: rule.cwd,
        agent: rule.to,
        worker: agent.worker,
        online: workerOnline(view, agent.worker, now),
        subjects: rule.when.subjects ?? [],
        aliases: rule.aliases ?? [],
        ...(last && {
          lastRun: last.id,
          lastSession: last.session ?? null,
          lastState: last.state,
          lastSummary: last.summary ?? null,
        }),
        canContinue: !!last?.session,
        ...(lastChoice && {
          lastDispatch: {
            run: lastChoice.dispatch_run,
            confidence: lastChoice.confidence,
            reason: lastChoice.reason ?? "",
            at: lastChoice.created_at,
          },
        }),
        preferences,
      };
    });
  const matters = stagesOf(view, rules, now)
    .filter((matter) => view.get("runs", matter.last)?.kind !== "dispatch")
    .map((matter) => {
      const definition = ruleOf(rules, matter.rule);
      return {
        ...(definition?.project && { project: definition.project }),
        rule: matter.rule,
        lane: matter.lane,
        stage: matter.stage,
        lastRun: matter.last,
      };
    });
  const recentRuns = rows(view, "runs")
    .filter((run) => !run.kind)
    .sort((a, b) => b.id - a.id)
    .slice(0, 20)
    .map((run) => {
      const definition = ruleOf(rules, run.rule);
      return {
        run: run.id,
        ...(definition?.project && { project: definition.project }),
        rule: run.rule,
        state: run.state,
        summary: run.summary ?? "",
        at: run.finished_at ?? null,
      };
    });
  return {
    minConfidence: rules.policy?.dispatch?.minConfidence ?? 0.7,
    create: rules.policy?.dispatch?.create === true,
    workers: rules.policy?.dispatch?.workers ?? [],
    projects,
    matters,
    recentRuns,
  };
}

/** The project a rule belongs to, and the project's rules. */
export const projectRules = (rules: Rules, project: string) => rules.rules.filter((rule) => rule.project === project);

export const safeFact = (fact: Fact) => ({ ...fact, changes: fact.changes.filter(({ table }) => table !== "keys") });
