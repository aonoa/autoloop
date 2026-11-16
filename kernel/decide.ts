// Everything that can change the hub is decided here: given the view and one input, the facts to record and the answer
// to give. Time and secrets come in as arguments, so the same input on the same view always decides the same.
import { credential, digest, type Environment } from "./credentials.ts";
import { latestBefore, nextRun, parseCron } from "./cron.ts";
import { deadlines, MINUTE, offlineCard, OFFLINE_AFTER, RUN_LEASE, SEEN_EVERY, WORKER_FRESH } from "./due.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { iso, rows, type Change, type Fact, type Row, type Table, type View } from "./evolve.ts";
import {
  agentsOf,
  cardView,
  configuration,
  dispatchOf,
  dispatchSnapshot,
  eventsOf,
  jobOf,
  takenEventsOf,
  openInScope,
  pauseOf,
  routingOf,
  sourceOf,
  waitingOn,
  workerOf,
  workerOnline,
  workers,
} from "./query.ts";
import {
  admit,
  cronOf,
  DISPATCH_RULE,
  eventRule,
  ruleOf,
  SCHEDULE,
  subjectMatches,
  typeMatches,
  type Rule,
  type Rules,
} from "./rules.ts";
import { stageOf } from "./stage.ts";
import {
  addUsage,
  ANSWER_BY,
  ANSWER_REF,
  ANSWER_TEXT,
  DELIVERY_REF,
  parseEvent,
  parseProgress,
  parseResult,
  type Later,
  type Rejected,
  type Result,
} from "../protocol/validate.ts";

export type Input = { type: string; args: any[] };

/** Minutes after the first try that a card is sent to a channel again. */
const RESEND_AT = [0, 1, 3, 7, 15, 25, 35, 45, 55];
/** The last resend and the minute it holds the card: after this a channel has given up. */
const RESEND_WINDOW = 57 * MINUTE;
/** How long a chain of events causing events can get before it stops being dispatched. */
const MAX_HOPS = 8;
/** Failures in a row after which a run stops being retried: each try spends the owner's real tokens. */
const MAX_ATTEMPTS = 10;
const NOT_TRYING = { tries: 0, first_try_at: null, not_before: null };
const NOT_DELIVERED: Row = { version: 0, ref: null, ...NOT_TRYING, error: null, given_up: 0 };

const nulls = (...names: string[]) => Object.fromEntries(names.map((name) => [name, null]));
const CARD_BASICS = { text: "", options: "[]", recommend: null, about: "", state: "open", fyi: 0, quiet: 0 };
const DEFAULTS: Partial<Record<Table, Row>> = {
  runs: {
    attempts: 0,
    ...nulls("claim", "issued", "last_issued", "last_result", "last_answer", "cancel_at", "resume", "session", "link"),
    ...nulls("claimed_at", "seen_at", "finished_at", "summary", "error", "usage"),
  },
  cards: {
    ...CARD_BASICS,
    ...nulls("choice", "answer", "by", "result", "rule"),
    lane: "",
    ...nulls("grp", "source", "agent", "session", "run_id", "answer_event"),
    version: 1,
    ...nulls("decided_at", "closed_at"),
  },
  deliveries: NOT_DELIVERED,
};

type Given = { type: string; seq: number; now: number; at: string; env: Environment; rules: Rules };
/** One input being decided: what holds throughout, and the view with its changes so far. */
type Draft = Given & { view: View; changes: Change[] };

export function decide(view: View, input: Input, now: number, env: Environment): { facts: Fact[]; value: any } {
  const { type, args } = input;
  if (!Object.hasOwn(HANDLERS, type)) throw new InputError(`不认识的输入：${type}`);
  const rules = configuration(view);
  const draft: Draft = { view: view.fork(), seq: view.seq + 1, type, now, at: iso(now), env, rules, changes: [] };
  const value = HANDLERS[type](draft, ...args);
  // With nothing changed nothing new can come due, and what only the clock changes has a deadline of its own to bring a tick.
  if (!draft.changes.length && type !== "tick") return { facts: [], value };
  const due = deadlines(draft.view, now);
  for (const [key, row] of Object.entries(due)) {
    if (JSON.stringify(draft.view.get("due", key)) !== JSON.stringify(row)) put(draft, "due", key, row);
  }
  for (const { kind, key: name } of rows(draft.view, "due")) {
    const key = `${kind}:${name}`;
    if (!due[key]) set(draft, "due", key, null);
  }
  return { facts: draft.changes.length ? [factOf(draft, draft.changes)] : [], value };
}

function factOf({ seq, now, type }: Draft, changes: Change[]): Fact {
  return { version: 1, seq, at: now, type, changes };
}

function set(draft: Draft, table: Table, key: string | number, row: Row | null) {
  const change = { table, key: String(key), row };
  draft.changes.push(change);
  draft.view.set(table, String(key), row);
  return row!;
}

const put = (draft: Draft, table: Table, key: string | number, fields: Row) =>
  set(draft, table, key, { ...DEFAULTS[table], ...draft.view.get(table, key), ...fields });

function add(draft: Draft, table: Table, fields: Row) {
  const id = (draft.view.next[table] ?? 0) + 1;
  return put(draft, table, id, { ...fields, id });
}

const ruleNamed = (draft: Draft, name: string) => ruleOf(draft.rules, name);
function assignQueued(draft: Draft, run: Row) {
  // A round with a kind belongs to the agent it was queued for: an assessor or a speculative try is not the rule's work.
  if (run.kind) return;
  const config = draft.view.get("config", "rules")!;
  const rule = ruleOf(config.value as Rules, run.rule);
  if (!rule) return;
  const session = rule.to === run.agent ? {} : nulls("session", "resume");
  put(draft, "runs", run.id, { agent: rule.to, rules_version: config.version, ...session });
}
const threadOf = (run: Row) => ({ rule: run.rule, lane: run.lane, grp: run.grp });

/** A notice about a run belongs where its events came from, so a private chat's failure goes back to that person rather
 * than to whatever conversation the channel is configured to use by default. */
function noticeTarget(draft: Draft, run: Row) {
  const reply = replyOf(draft.view, run.id);
  return { ...threadOf(run), ...(reply && { reply }) };
}

/** The session a round about to start goes on in. With resume, one that has none takes its thread's last, unless that round was
 * stopped: what stopped it, or the owner's reason, would meet this one too. Rounds on a thread can share a session, so another
 * still going, or one the hub lost track of, may be running in it: a second process mustn't open it, and a new one starts. */
function settleSession(draft: Draft, run: Row) {
  const rule = ruleNamed(draft, run.rule);
  const thread = { rule: run.rule, lane: run.lane };
  const carried = run.session ?? run.resume;
  let session = carried;
  if (!session && rule?.resume) {
    const [last] = rows(draft.view, "runs", { ...thread, state: ["done", "nothing", "cancelled"] }, 1, true);
    if (last?.state !== "cancelled" && last?.agent === rule.to) session = last.session;
  }
  if (!session) return;
  const going = rows(draft.view, "runs", { ...thread, state: ["claimed", "unknown"] });
  if (going.some((other) => (other.session ?? other.resume) === session)) {
    put(draft, "runs", run.id, nulls("session", "resume"));
  } else if (session !== carried) put(draft, "runs", run.id, { resume: session });
}
const hopsOf = (draft: Draft, run: Row) =>
  Math.max(0, ...takenEventsOf(draft.view, run.id).map((event) => event.hops ?? 0));

function closeCard(draft: Draft, card: Row, result: string, by: string | null = null, note: string | null = null) {
  const closed = { state: "closed", closed_at: draft.at, version: card.version + 1 };
  // A note says how a notice was handled, for looking back at later.
  put(draft, "cards", card.id, { ...closed, result, by: by ?? card.by, ...(note ? { answer: note } : {}) });
}

function closeOpen(draft: Draft, matches: (key: string) => boolean, result: string) {
  const open = rows(draft.view, "cards", { state: "open" }).filter((card) => matches(card.key));
  for (const card of open) closeCard(draft, card, result);
}

/** Once it's stopped, nothing should still say it will try again, or that it may still be going. */
const closeStopped = (draft: Draft, run: number, result: string) =>
  closeOpen(draft, (key) => key === `run:${run}:failing` || key === `run:${run}:unknown`, result);

const closeOffline = (draft: Draft, worker: string) =>
  closeOpen(draft, (key) => key.startsWith(`worker:${worker}:offline:`), "连上了");

/** The conversation a run's events came from, when all of them agree on one. It is data from the source, never a target
 * chosen by the Agent. */
function replyOf(view: View, runId: number) {
  const replies = [
    ...new Set(
      takenEventsOf(view, runId)
        .map((event) => event.reply)
        .filter(Boolean),
    ),
  ];
  return replies.length === 1 ? String(replies[0]) : undefined;
}

/** Whether a new stamp would tell nothing this one doesn't. One in the future means a clock was set back: it gets redone. */
function justSeen({ now }: Draft, row?: Row) {
  const age = now - Date.parse(row?.seen_at);
  return age >= 0 && age < SEEN_EVERY;
}

function createCard(draft: Draft, spec: Row) {
  const [existing] = rows(draft.view, "cards", { key: spec.key, ...(!spec.once && { state: "open" }) }, 1, true);
  if (existing) return { card: existing.id, duplicate: true };
  const { once, options, fyi, quiet, run, run_id: runId, ...fields } = spec;
  const stored = {
    run_id: runId ?? run ?? null,
    options: JSON.stringify(options ?? []),
    fyi: fyi ? 1 : 0,
    quiet: quiet ? 1 : 0,
  };
  const state = fyi ? { state: "closed", closed_at: draft.at } : { state: "open" };
  const card = add(draft, "cards", { ...fields, ...stored, ...state, created_at: draft.at });
  return { card: card.id, duplicate: false };
}

const notify = (draft: Draft, key: string, title: string, text: string, extra: Row = {}) =>
  createCard(draft, { key, kind: "notice", title, text, ...extra });

/** A queued run of this rule and thread takes the event, so what comes in while it waits is handled together. */
function enqueue(
  draft: Draft,
  rule: Rule,
  event: number,
  lane: string,
  resume?: string | null,
  fromPerson = false,
  speculative = false,
  fresh = false,
) {
  // A matter waiting on a person after a blocked or failed report takes no automatic input: only their message releases it.
  if (!fromPerson) {
    const stage = stageOf(draft.view, draft.rules, rule.name, lane, draft.now);
    if (stage === "person/blocked" || stage === "person/failed") return null;
  }
  const rulesVersion = draft.view.get("config", "rules")!.version;
  const stamps = { not_before: draft.at, created_at: draft.at, rules_version: rulesVersion };
  const kind = speculative ? "speculate" : undefined;
  const run =
    (!fresh &&
      rows(draft.view, "runs", { rule: rule.name, lane, state: "queued" }).find(
        (other) => (other.kind ?? null) === (kind ?? null),
      )) ||
    add(draft, "runs", {
      rule: rule.name,
      agent: rule.to,
      grp: rule.group,
      lane,
      state: "queued",
      ...(kind && { kind }),
      ...stamps,
    });
  put(draft, "run_events", `${run.id}:${event}`, { run_id: run.id, event_id: event });
  if (fresh) put(draft, "runs", run.id, { session: null, resume: null });
  if (resume) put(draft, "runs", run.id, { resume });
  return run.id as number;
}

/** Keeps an event under a key of its own: one the hub makes up mustn't collide with one a source sent. */
function recordEvent(
  draft: Draft,
  source: string,
  event: Row,
  matched: string[],
  paused: string[] = [],
  sent = false,
): number {
  let key = event.id;
  for (let suffix = 1; rows(draft.view, "events", { source, key }).length; suffix++) {
    key = `${event.id}:${suffix}`;
  }
  return add(draft, "events", {
    source,
    key,
    type: event.type,
    subject: event.subject ?? "",
    summary: event.summary ?? "",
    detail: event.detail ?? "",
    link: event.link ?? "",
    hops: event.hops ?? 0,
    actor: event.actor ?? "",
    // `parseEvent` may drop a field whose value is empty; `ingest` passes the parsed event, which carries a validated reply.
    ...(event.reply && { reply: event.reply }),
    ...(event.attachments && { attachments: event.attachments }),
    // What the rules matched. `routed` is what was actually dispatched, and is filled in as work is queued.
    matched: JSON.stringify(matched),
    routed: "[]",
    // Kept as an alias of `routed` for facts written before `matched` existed; `routingOf` reads it as a fallback.
    dispatched: "[]",
    // Only where a pause held it back, so the owner's list of what was skipped reads an index of those alone.
    ...(paused.length && { paused: JSON.stringify(paused) }),
    // Through the source's own door: only these are its to read back (`eventOutcome`), not what the hub made in its name.
    ...(sent && { sent: 1 }),
    ...nulls("dispatch_run", "dispatch_state", "dispatch_project"),
    received_at: draft.at,
  }).id;
}

/** Whether an event came from outside. A rule's own emits are authorized by that rule, not by the source's policy. */
type Origin = "external" | "rule";

/** Notifications and answers report on work; they are never tasks and never need a project. */
const isTaskEvent = (type: string) =>
  !["card.answered", "timer.due", "schedule.tick", "run.manual"].includes(type) && !type.startsWith("notice.");

function ingest(draft: Draft, source: string, given: unknown, sent = false, origin: Origin = "external") {
  const event = parseEvent(given);
  const existing = rows(draft.view, "events", { source, key: event.id })[0];
  if (existing) {
    return { event: existing.id, duplicate: true, ...routingOf(existing), ...dispatchOf(existing) };
  }
  const tooDeep = event.hops > MAX_HOPS;
  const takes = (rule: Rule) =>
    eventRule(rule) &&
    rule.when.source === source &&
    typeMatches(rule.when.types, event.type) &&
    subjectMatches(rule.when.subjects, event.subject);
  const matched = tooDeep ? [] : draft.rules.rules.filter(takes);
  // A paused rule doesn't take the event, and nothing is kept back for it: the event is recorded as skipped for it.
  const isPaused = (rule: Rule) => !!pauseOf(draft.view, rule, draft.now);
  const paused = matched.filter(isPaused).map((rule) => rule.name);
  // With a policy, the gate decides before a rule is queued: a refused event is still recorded, so it can be looked at.
  const sourcePolicy = draft.rules.sources[source]?.policy;
  const verdicts = new Map(
    matched.map(
      (rule) =>
        [
          rule.name,
          origin === "rule" && draft.rules.policy
            ? ({ state: "accept", strength: "explicit", reason: "rule_emits" } as const)
            : admit(draft.rules.policy, sourcePolicy, { id: rule.to, name: draft.rules.agents[rule.to].name }, event),
        ] as const,
    ),
  );
  const admitted = matched.filter((rule) => verdicts.get(rule.name)!.state === "accept");
  const refused = matched.filter((rule) => verdicts.get(rule.name)!.state === "ignore").map((rule) => rule.name);
  // With `assess`, a gate-accepted event is not dispatched yet: an assessor round decides first, in its own run. An event
  // a rule emits is already authorized by that rule's `emits`, so it is not put through the source's policy again.
  const assessing = draft.rules.policy?.accept === "assess" && origin !== "rule";
  const taking = admitted.filter((rule) => !isPaused(rule) && !assessing);
  const toAssess = admitted.filter((rule) => !isPaused(rule) && assessing);
  const id = recordEvent(
    draft,
    source,
    event,
    matched.map((rule) => rule.name),
    paused,
    sent,
  );
  for (const rule of matched) recordDecision(draft, id, source, event, rule, verdicts.get(rule.name)!);
  // What a source's own door reads back: the rules that took it, and the ones a policy refused.
  if (refused.length) put(draft, "events", id, { refused: JSON.stringify(refused) });
  if (tooDeep) {
    const words = `同一条处理链已超过 ${MAX_HOPS} 层，后续事件已记录，没有继续派发。`;
    notify(draft, `hops:${source}:${event.id}`, "事件循环已停止", words, { once: true });
  }
  const dispatched: string[] = [];
  for (const rule of taking) {
    // A speculative rule tries in the background first: nothing is delivered unless the round found something worth it.
    const run = enqueue(draft, rule, id, rule.parallel ? event.subject : "", null, false, !!rule.speculate);
    if (run === null) continue;
    // A speculative try is not the rule's work yet: it takes no mandate, is not dispatched, and starts no fan-out. The
    // real round it may hand over to does all three when the try comes back.
    if (rule.speculate) continue;
    dispatched.push(rule.name);
    dispatch(draft, id, rule, verdicts.get(rule.name)!, undefined, false);
  }
  for (const rule of toAssess) enqueueAssessment(draft, id, source, event, rule);
  // An event no rule matched, or one only a project's alias names, is placed deterministically first. Only a dispatcher
  // sees what is left, and it never sees an event a policy refused.
  const eventRow = draft.view.get("events", id)!;
  const alias = !matched.length && !tooDeep && origin === "external" ? byAlias(draft, eventRow) : undefined;
  let dispatchRun: number | null = null;
  if (alias) {
    // An alias is still an automatic external event: it must not wake a matter that is waiting for a person.
    const run = enqueue(draft, alias, id, alias.parallel ? event.subject : "", null, false);
    const admission = routeAdmission(draft, eventRow, alias);
    if (run !== null) {
      dispatch(draft, id, alias, admission, alias.project);
      put(draft, "events", id, { dispatch_state: "placed", dispatch_project: alias.project });
    }
    if (run !== null) dispatched.push(alias.name);
  } else if (
    !matched.length &&
    origin === "external" &&
    isTaskEvent(event.type) &&
    draft.rules.policy?.dispatch &&
    !tooDeep &&
    sourceAdmitsActor(draft, eventRow)
  ) {
    dispatchRun = enqueueDispatch(draft, id, source);
  }
  // Only an event a rule took may become context: a refused event stays out of every live matter too.
  if (draft.rules.policy?.fanout && event.subject && dispatched.length)
    fanOut(draft, id, event, new Set(matched.map((rule) => rule.name)));
  return {
    event: id,
    duplicate: false,
    routed: dispatched,
    paused,
    ...(dispatchRun !== null && { dispatch: { state: "queued", run: dispatchRun }, pending: true }),
    ...(refused.length && { refused }),
  };
}

/** One decision per event and rule: what the gate said, and why, whether or not it started work. */
function recordDecision(
  draft: Draft,
  eventId: number,
  source: string,
  event: Row,
  rule: Rule,
  admission: ReturnType<typeof admit>,
) {
  add(draft, "decisions", {
    event_id: eventId,
    rule: rule.name,
    source,
    actor: event.actor ?? "",
    state: admission.state,
    reason: admission.reason,
    ...(admission.state === "accept" && { strength: admission.strength }),
    rules_version: draft.view.get("config", "rules")!.version,
    decided_at: draft.at,
  });
}

/** What an accepted event grants: immutable, and only the rules it matched under this rules version. */
function recordMandate(
  draft: Draft,
  eventId: number,
  rule: Rule,
  admission: ReturnType<typeof admit>,
  scope = rule.group,
) {
  if (admission.state !== "accept") return;
  put(draft, "mandates", `${eventId}:${rule.name}`, {
    event_id: eventId,
    rule: rule.name,
    strength: admission.strength,
    reason: admission.reason,
    scope,
    rules_version: draft.view.get("config", "rules")!.version,
    granted_at: draft.at,
  });
}

/** A round of the assessor Agent: it reads the event and answers with a verdict, and nothing is dispatched until it does. */
function enqueueAssessment(draft: Draft, eventId: number, source: string, event: Row, rule: Rule) {
  const assessor = draft.rules.policy?.assessor!;
  const lane = rule.parallel ? event.subject : "";
  const run =
    rows(draft.view, "runs", { rule: rule.name, lane, state: "queued", kind: "assess" })[0] ??
    add(draft, "runs", {
      rule: rule.name,
      agent: assessor,
      grp: rule.group,
      lane,
      state: "queued",
      kind: "assess",
      not_before: draft.at,
      created_at: draft.at,
      rules_version: draft.view.get("config", "rules")!.version,
    });
  put(draft, "run_events", `${run.id}:${eventId}`, { run_id: run.id, event_id: eventId });
  return run.id;
}

/**
 * The events this assessment is allowed to settle. Fan-out adds other rules' events to a live matter as context, and
 * that context must not become authority for the rule being assessed.
 */
function assessedEventsOf(draft: Draft, run: Row): Row[] {
  return rows(draft.view, "run_events", { run_id: run.id })
    .filter((link) => !link.context)
    .map((link) => draft.view.get("events", link.event_id)!)
    .sort((a, b) => a.id - b.id);
}

/** The rules an event has actually dispatched: what a source reads back, not every rule it matched. */
function dispatchedOf(event: Row): string[] {
  return JSON.parse(event.dispatched ?? "null") ?? JSON.parse(event.routed ?? "[]");
}

function markDispatched(draft: Draft, eventId: number, rule: string) {
  const event = draft.view.get("events", eventId)!;
  const dispatched = dispatchedOf(event);
  if (!dispatched.includes(rule))
    put(draft, "events", eventId, {
      routed: JSON.stringify([...dispatched, rule]),
      dispatched: JSON.stringify([...dispatched, rule]),
    });
}

/** An internal event (timer, schedule, answer, replay, manual run) has no gate round of its own: dispatch records the accept. */
function ensureDecision(
  draft: Draft,
  eventId: number,
  rule: Rule,
  admission: ReturnType<typeof admit>,
  scope?: string,
) {
  // A refusal may already be on record, for example while the rule was paused. Dispatching is itself the acceptance, so
  // the audit trail must hold an accept as well; an earlier accept is the one to keep.
  if (
    rows(draft.view, "decisions", { event_id: eventId, rule: rule.name }).some(
      (decision) => decision.state === "accept",
    )
  )
    return;
  const event = draft.view.get("events", eventId)!;
  add(draft, "decisions", {
    event_id: eventId,
    rule: rule.name,
    source: event.source,
    actor: event.actor ?? "",
    state: admission.state,
    reason: admission.reason,
    ...(admission.state === "accept" && { strength: admission.strength, scope: scope ?? rule.group }),
    rules_version: draft.view.get("config", "rules")!.version,
    decided_at: draft.at,
  });
}

/** A real round now holds the event: this is the one place dispatch, its mandate, and fan-out are recorded. */
function dispatch(
  draft: Draft,
  eventId: number,
  rule: Rule,
  admission: ReturnType<typeof admit>,
  scope?: string,
  fanout = true,
) {
  ensureDecision(draft, eventId, rule, admission, scope);
  markDispatched(draft, eventId, rule.name);
  recordMandate(draft, eventId, rule, admission, scope);
  if (!fanout) return;
  const event = draft.view.get("events", eventId)!;
  if (draft.rules.policy?.fanout && event.subject)
    fanOut(draft, eventId, event, new Set(JSON.parse(event.matched ?? "[]")));
}

/** The gate's answer for a route the hub chose: the same source policy a normal match would meet. */
function routeAdmission(draft: Draft, event: Row, rule: Rule) {
  const sourcePolicy = draft.rules.sources[event.source]?.policy;
  const agent = draft.rules.agents[rule.to];
  return admit(
    draft.rules.policy,
    sourcePolicy,
    { id: rule.to, name: agent.name },
    {
      subject: event.subject ?? "",
      summary: event.summary ?? "",
      actor: event.actor ?? "",
    },
  );
}

/** The deterministic way to place an unplaced event: an exact subject or an alias. It grants nothing until the rule is taken. */
function byAlias(draft: Draft, event: Row) {
  const rule = draft.rules.rules.find(
    (rule) =>
      rule.project &&
      eventRule(rule) &&
      rule.when.source === event.source &&
      typeMatches(rule.when.types, event.type) &&
      [...(rule.when.subjects ?? []), ...(rule.aliases ?? [])].some((pattern) =>
        subjectMatches([pattern], event.subject),
      ),
  );
  if (!rule || routeAdmission(draft, event, rule).state !== "accept") return undefined;
  // An alias chooses a project; it does not bypass the project's node or its waiting-for-a-person stage.
  return placementProblem(draft, event, rule.project!) === null ? rule : undefined;
}

/** The source-level part of the gate, before a project is known: who may originate work at all. */
function sourceAdmitsActor(draft: Draft, event: Row) {
  const policy = draft.rules.policy;
  const source = draft.rules.sources[event.source]?.policy;
  if (!policy || (policy.accept ?? "off") === "off" || !source) return true;
  const actor = String(event.actor ?? "");
  if (!actor) return false;
  if (source.bots?.includes(actor)) return true;
  return !source.allowlist?.length || source.allowlist.includes(actor);
}

/** The project a dispatcher named, if this source and event type can reach its rule. */
function projectRule(draft: Draft, project: string, source: string, type: string) {
  return draft.rules.rules.find(
    (rule) =>
      rule.project === project && eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, type),
  );
}

const CREATE_ID = /^[A-Za-z0-9._-]{1,40}$/;
const CREATE_FOLDER = /^(~[/\\]|\/|[a-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/i;

/** Why a project the dispatcher wants to create cannot be created, or null when the hub can ask the host to write it. */
function creationProblem(draft: Draft, event: Row, create: NonNullable<Result["create"]>) {
  if (!draft.rules.policy?.dispatch?.create) return "没有开启自动创建项目";
  const minConfidence = draft.rules.policy.dispatch.minConfidence ?? 0.7;
  if (create.confidence < minConfidence) return `新建项目的置信度 ${create.confidence} 低于 ${minConfidence}`;
  if (!CREATE_ID.test(create.project)) return "新项目名只能用字母、数字和 . _ -，最多 40 个字符";
  if (draft.rules.rules.some((rule) => rule.project === create.project)) return `项目「${create.project}」已经存在`;
  if (rows(draft.view, "project_creations", { project: create.project, state: "pending" }).length)
    return `项目「${create.project}」已经有待写入的创建提议`;
  if (create.cwd && !CREATE_FOLDER.test(create.cwd)) return "新项目目录要是绝对目录（如 ~/code、/srv/app）";
  const allowed = draft.rules.policy.dispatch.workers;
  const agents = Object.entries(draft.rules.agents);
  const agent = create.agent ? draft.rules.agents[create.agent] : undefined;
  if (create.agent && !agent) return `没有 Agent：${create.agent}`;
  if (create.worker) {
    const candidates = agents.filter(([, one]) => one.worker === create.worker);
    if (!candidates.length) return `没有节点 ${create.worker}`;
    if (agent && agent.worker !== create.worker) return `Agent ${create.agent} 不在节点 ${create.worker}`;
  }
  if (!create.worker && !agent && !agents.length) return "没有可用的 Agent";
  // The host may choose the default Agent when the proposal names neither one nor a node. Check that final placement, not
  // just an explicitly named worker, so a whitelist cannot be bypassed by omitting both fields.
  const fallback = create.worker
    ? undefined
    : (agent ?? agents.find(([id]) => id === "general")?.[1] ?? agents[0]?.[1]);
  const worker = create.worker ?? fallback?.worker;
  if (allowed?.length && (!worker || !allowed.includes(worker)))
    return worker ? `节点 ${worker} 不在自动创建项目的允许列表里` : "自动创建项目没有可用的节点";
  if (!event.source) return "找不到来源";
  return null;
}

/** A round of the dispatcher Agent: it reads an unplaced event and answers with a route, and does no work. */
function enqueueDispatch(draft: Draft, eventId: number, source: string) {
  const agent = draft.rules.policy?.dispatch?.agent;
  if (!agent) return null;
  // One unplaced event, one round: a dispatcher answers for one event, so merging several into a round would leave all
  // but the first unassigned.
  const run = add(draft, "runs", {
    rule: DISPATCH_RULE,
    agent,
    grp: "dispatch",
    lane: "",
    state: "queued",
    kind: "dispatch",
    source: `dispatch:${source}`,
    not_before: draft.at,
    created_at: draft.at,
    rules_version: draft.view.get("config", "rules")!.version,
  });
  put(draft, "run_events", `${run.id}:${eventId}`, { run_id: run.id, event_id: eventId });
  put(draft, "events", eventId, { dispatch_run: run.id, dispatch_state: "queued" });
  return run.id as number;
}

/** A project the dispatcher proposed, after the host has written it: the event goes back through the dispatcher. */
function createdProject(draft: Draft, eventId: number, project: string) {
  const event = draft.view.get("events", eventId);
  if (!event || event.dispatch_state !== "creating") return;
  put(draft, "events", eventId, { dispatch_state: "queued", dispatch_project: project });
  const run = enqueueDispatch(draft, eventId, event.source);
  if (run !== null) put(draft, "events", eventId, { dispatch_run: run, dispatch_state: "queued" });
}

/** Every lane that may hold this project's work for this event: the raw subject and the lane a placement would use. */
function placementLanes(rule: Rule, event: Row) {
  return [
    ...new Set([rule.parallel ? event.subject : "", placedLane({ ...rule, parallel: rule.parallel ?? 1 }, event)]),
  ];
}

/** Why a project cannot take this event: the hub's answer, never the model's word. */
function placementProblem(draft: Draft, event: Row, project: string, lanes?: string[]) {
  const rule = projectRule(draft, project, event.source, event.type);
  if (!rule) return `项目「${project}」没有能接这个来源和类型的规则`;
  const agent = draft.rules.agents[rule.to];
  if (!agent) return `项目「${project}」的 Agent 不在了`;
  if (!workerOnline(draft.view, agent.worker, draft.now))
    return `项目「${project}」所在的节点 ${agent.worker} 没上线或已离线`;
  if (routeAdmission(draft, event, rule).state === "ignore") return "这件事的发送人没有权限放进这个项目";
  const blocked = (lanes ?? placementLanes(rule, event)).some((lane) => {
    const stage = stageOf(draft.view, draft.rules, rule.name, lane, draft.now);
    return stage === "person/blocked" || stage === "person/failed";
  });
  if (blocked) return `项目「${project}」现在在等人处理，不能接新活`;
  return null;
}

/** Why a route cannot be used: the hub's answer, never the model's word. */
function routeProblem(draft: Draft, run: Row, route: NonNullable<Result["route"]>) {
  const [event] = assessedEventsOf(draft, run);
  if (!event) return "找不到要分配的事件";
  const rule = projectRule(draft, route.project, event.source, event.type);
  return placementProblem(draft, event, route.project, rule ? placementLanes(rule, event) : undefined);
}

/** The projects a person may choose for an event: those whose rules can take it and whose source admits it. */
function projectChoices(draft: Draft, event: Row) {
  const projects = draft.rules.rules
    .filter(
      (rule) =>
        rule.project &&
        eventRule(rule) &&
        rule.when.source === event.source &&
        typeMatches(rule.when.types, event.type) &&
        routeAdmission(draft, event, rule).state === "accept",
    )
    .map((rule) => rule.project!);
  return [...new Set(projects)].filter((project) => !placementProblem(draft, event, project));
}

/** A card that lets a person place an event. Its answer is read by `answer`, not by the dispatcher. */
function askPlacement(draft: Draft, event: Row, run: Row, title: string, why: string, projects: string[], key: string) {
  const offered = projects.slice(0, 4);
  const listed = offered.length ? `\n可选项目：${offered.join("、")}。` : "";
  // A card needs at least two choices; with no project able to take it, the only real choice is to leave it.
  const options = offered.length ? [...offered, "先放着"] : ["先放着", "知道了"];
  return createCard(draft, {
    key,
    kind: "ask",
    title,
    text: `${why}。${listed}\n\n来源：${event.source}\n事件：${event.summary || event.type}`,
    options,
    source: event.source,
    lane: event.subject,
    grp: "dispatch",
    run_id: run.id,
    ...(event.reply && { reply: event.reply }),
    ...(event.attachments && { attachments: event.attachments }),
    about: `调度事件 ${event.id}`,
  });
}

/** The lane a placed event belongs to. A conversation-only subject is split by project, so two projects never share one. */
function placedLane(rule: Rule, event: Row) {
  if (!rule.parallel) return "";
  if (!rule.project) return event.subject;
  return event.subject.endsWith(`/${rule.project}`) ? event.subject : `${event.subject}/${rule.project}`;
}

/** The session a dispatcher's `continue` may safely take, and why. A session another live round holds is never reused. */
function continuation(draft: Draft, rule: Rule, lane: string) {
  const [last] = rows(draft.view, "runs", { rule: rule.name, lane, state: ["done", "nothing"] }, 1, true);
  if (!last?.session) return { resume: undefined, why: "没有可续的会话，开新会话" };
  if (last.agent !== rule.to) return { resume: undefined, why: "上次是别的 Agent 跑的，开新会话" };
  const busy = rows(draft.view, "runs", { rule: rule.name, lane, state: ["queued", "claimed", "unknown"] }).some(
    (run) => (run.session ?? run.resume) === last.session,
  );
  if (busy) return { resume: undefined, why: "上次的会话还被别的轮占着，开新会话" };
  return { resume: last.session, why: "接着上次成功的会话" };
}

/** One structured record for a dispatcher round. The model's route is a suggestion; this is the hub's own outcome. */
function recordDispatch(
  draft: Draft,
  run: Row,
  event: Row,
  outcome: "placed" | "unassigned" | "replied" | "failed",
  route?: Result["route"],
  why?: string,
) {
  const candidates = projectChoices(draft, event);
  add(draft, "dispatch_decisions", {
    event_id: event.id,
    dispatch_run: run.id,
    source: event.source,
    actor: event.actor ?? "",
    snapshot_version: draft.view.get("config", "rules")!.version,
    candidates: JSON.stringify(candidates),
    ...(route?.project && { project: route.project }),
    ...(route?.session && { session: route.session }),
    ...(route && { confidence: route.confidence }),
    reason: why ?? route?.reason ?? "",
    outcome,
    created_at: draft.at,
  });
  put(draft, "events", event.id, {
    dispatch_run: run.id,
    dispatch_state: outcome,
    ...(outcome === "placed" && route?.project && { dispatch_project: route.project }),
  });
}

/** A dispatcher's direct answer to a non-task. It goes back to the conversation, and it starts no work. */
function directReply(draft: Draft, run: Row, event: Row, notices: Result["notice"] = []) {
  const reply = event.reply ? { reply: event.reply } : {};
  for (const notice of notices.slice(0, 1)) {
    notify(draft, `dispatch:${event.id}:reply`, notice.title, notice.text, {
      fyi: true,
      source: event.source,
      lane: event.subject,
      ...reply,
    });
  }
  recordDispatch(draft, run, event, "replied", undefined, "直接回复");
}

/** Tell the original conversation where a placed task went, once the hub has actually accepted it. */
function placedNotice(draft: Draft, event: Row, project: string) {
  notify(
    draft,
    `dispatch:${event.id}:placed`,
    "任务已分配",
    `已放到项目「${project}」。任务：${event.summary || event.type}`,
    {
      fyi: true,
      source: event.source,
      lane: event.subject,
      ...(event.reply && { reply: event.reply }),
      ...(event.attachments && { attachments: event.attachments }),
    },
  );
}

/** Put an event into a project through the same dispatch path as any other event. */
function placeEvent(
  draft: Draft,
  event: Row,
  project: string,
  session: "continue" | "new",
  reason: string,
): string | null {
  const rule = projectRule(draft, project, event.source, event.type);
  if (!rule) return `项目「${project}」没有能接这个来源和类型的规则`;
  const problem = placementProblem(draft, event, project);
  if (problem) return problem;
  const lane = placedLane({ ...rule, parallel: rule.parallel ?? 1 }, event);
  const kept = session === "continue" ? continuation(draft, rule, lane) : { resume: undefined, why: "按要求开新会话" };
  const resume = kept.resume;
  // `continue` only means "continue if that is safe". With no usable session, or one another live round holds, this is
  // a new session: merging into that busy round would run two unrelated tasks in one conversation.
  const queued = enqueue(draft, rule, event.id, lane, resume, false, false, !resume);
  if (queued === null) return `项目「${project}」现在不能接新活`;
  dispatch(
    draft,
    event.id,
    rule,
    { state: "accept", strength: "inferred", reason: "dispatched" },
    reason || project,
    false,
  );
  put(draft, "events", event.id, { dispatch_project: project, dispatch_state: "placed" });
  placedNotice(draft, event, project);
  return null;
}

/** A dispatcher's route: checked here, then the same dispatch path as any other event. */
function applyRoute(draft: Draft, run: Row, result: Result) {
  put(draft, "runs", run.id, {
    state: result.outcome,
    finished_at: draft.at,
    summary: result.summary ?? "",
    error: null,
    cancel_at: null,
  });
  closeOpen(draft, (key) => key === `run:${run.id}:failing`, "后来跑成了");
  closeOpen(draft, (key) => key === `run:${run.id}:unknown`, "结果回来了");
  const [event] = assessedEventsOf(draft, run);
  if (!event) return [];
  const route = result.route;
  const create = result.create;
  const notices = result.notice ?? [];
  const direct = notices.filter((notice) => notice.fyi === true);
  if (create) {
    if (result.ask?.length || result.resolve?.length || result.later?.length || result.events?.length) {
      recordDispatch(draft, run, event, "unassigned", undefined, "调度轮只能创建项目或直接回复");
      unassigned(draft, event, run, "调度轮只能创建项目或直接回复，不能提问、定时或发事件");
      return [];
    }
    if (route) {
      recordDispatch(draft, run, event, "unassigned", route, "调度不能同时创建项目和分配已有项目");
      unassigned(draft, event, run, "调度不能同时创建项目和分配已有项目", route);
      return [];
    }
    const problem = creationProblem(draft, event, create);
    if (problem) {
      recordDispatch(draft, run, event, "unassigned", undefined, problem);
      unassigned(draft, event, run, problem);
      return [];
    }
    add(draft, "project_creations", {
      event_id: event.id,
      dispatch_run: run.id,
      source: event.source,
      event_type: event.type,
      actor: event.actor ?? "",
      project: create.project,
      description: create.description,
      cwd: create.cwd ?? "",
      agent: create.agent ?? "",
      worker: create.worker ?? "",
      subjects: JSON.stringify(create.subjects ?? []),
      confidence: create.confidence,
      state: "pending",
      reason: result.summary ?? "",
      created_at: draft.at,
    });
    recordDispatch(draft, run, event, "unassigned", undefined, `提议新建项目「${create.project}」，等待中台写入配置`);
    put(draft, "events", event.id, { dispatch_state: "creating" });
    notify(
      draft,
      `dispatch:${event.id}:creating`,
      "正在新建项目",
      `调度建议新建项目「${create.project}」。中台写入配置后会重新判断这件事。`,
      { fyi: true, source: event.source, lane: event.subject, ...(event.reply && { reply: event.reply }) },
    );
    return [];
  }
  if (!route && direct.length) {
    directReply(draft, run, event, direct);
    return [];
  }
  // A dispatcher is a translation round, not a work round: execution-only receipts are refused instead of applied.
  if (result.ask?.length || result.resolve?.length || result.later?.length || result.events?.length) {
    recordDispatch(draft, run, event, "unassigned", route, "调度轮只能分配或直接回复");
    unassigned(draft, event, run, "调度轮只能分配项目或直接回复，不能提问、定时或发事件");
    return [];
  }
  const problem = route ? routeProblem(draft, run, route) : "调度没有给出项目";
  if (route && !problem && route.confidence < (draft.rules.policy?.dispatch?.minConfidence ?? 0.7)) {
    recordDispatch(draft, run, event, "unassigned", route, `调度拿不准（置信度 ${route.confidence}）`);
    unassigned(draft, event, run, `调度拿不准（置信度 ${route.confidence}），项目「${route.project}」没有执行`, route);
    return [];
  }
  if (!route) {
    recordDispatch(draft, run, event, "unassigned", undefined, problem ?? "调度没有给出项目");
    unassigned(draft, event, run, problem ?? "调度没有给出项目");
    return [];
  }
  if (problem) {
    recordDispatch(draft, run, event, "unassigned", route, problem);
    unassigned(draft, event, run, problem ?? "调度没有给出项目", route);
    return [];
  }
  if (route.session === "ask") {
    recordDispatch(draft, run, event, "unassigned", route, "等本人确认项目");
    const choices = projectChoices(draft, event);
    const rest = choices.filter((project) => project !== route.project);
    askPlacement(
      draft,
      event,
      run,
      "这件事要放到哪个项目？",
      `调度建议「${route.project}」，但需要你确认`,
      [route.project, ...rest],
      `dispatch-ask:${event.id}`,
    );
    return [];
  }
  const problemNow = placeEvent(draft, event, route.project, route.session, route.reason ?? route.project);
  if (problemNow) {
    recordDispatch(draft, run, event, "unassigned", route, problemNow);
    unassigned(draft, event, run, problemNow, route);
  } else {
    const rule = projectRule(draft, route.project, event.source, event.type)!;
    const kept =
      route.session === "continue"
        ? continuation(draft, rule, placedLane({ ...rule, parallel: rule.parallel ?? 1 }, event))
        : null;
    recordDispatch(
      draft,
      run,
      event,
      "placed",
      route,
      `${route.reason ?? route.project}${kept ? `；${kept.why}` : ""}`,
    );
  }
  return [];
}

/** An event no project took: recorded once, and shown to a person with the route that was considered. */
function unassigned(draft: Draft, event: Row, run: Row, why: string, route?: Result["route"]) {
  const key = `dispatch:${event.id}`;
  if (rows(draft.view, "cards", { key }, 1, true)[0]) return;
  const considered = route
    ? `\n考虑过项目「${route.project}」，置信度 ${route.confidence}${route.reason ? `：${route.reason}` : ""}。`
    : "";
  askPlacement(draft, event, run, "有件事没分配到项目", `${why}${considered}`, projectChoices(draft, event), key);
  if (draft.view.get("events", event.id)?.dispatch_state !== "failed")
    put(draft, "events", event.id, { dispatch_state: "unassigned" });
}

/** What an assessor round decided about each event it read: the only thing that makes its rule take the event. */
function applyVerdict(draft: Draft, run: Row, verdict: NonNullable<Result["verdict"]>) {
  const rule = ruleNamed(draft, run.rule);
  if (!rule) return;
  for (const event of assessedEventsOf(draft, run)) {
    const eventId = event.id;
    if (verdict.decision === "accept") {
      const strength = verdict.strength ?? "inferred";
      add(draft, "decisions", {
        event_id: eventId,
        rule: rule.name,
        source: event.source,
        actor: event.actor ?? "",
        state: "accept",
        reason: verdict.reason ?? "assessed",
        strength,
        scope: verdict.scope ?? rule.group,
        rules_version: draft.view.get("config", "rules")!.version,
        decided_at: draft.at,
      });
      const queued = enqueue(draft, rule, eventId, rule.parallel ? event.subject : "", null, false, !!rule.speculate);
      // A matter waiting on a person takes no new work: the decision stands, but nothing is granted for it.
      if (queued === null) continue;
      // A speculative rule rehearses first: the try delivers the real round, and only that round is dispatched.
      if (rule.speculate) continue;
      dispatch(
        draft,
        eventId,
        rule,
        { state: "accept", strength, reason: verdict.reason ?? "assessed" },
        verdict.scope,
      );
    } else {
      add(draft, "decisions", {
        event_id: eventId,
        rule: rule.name,
        source: event.source,
        actor: event.actor ?? "",
        state: verdict.decision,
        reason: verdict.reason ?? verdict.decision,
        rules_version: draft.view.get("config", "rules")!.version,
        decided_at: draft.at,
      });
      const refused = JSON.parse(draft.view.get("events", eventId)!.refused ?? "[]") as string[];
      put(draft, "events", eventId, { refused: JSON.stringify([...new Set([...refused, rule.name])]) });
    }
  }
}

/**
 * Subscription fan-out: an event also reaches the live matters of other rules on the same subject, as context only. It
 * grants nothing and takes no gate: those matters already exist, and their rules were already authorized.
 */
function fanOut(draft: Draft, eventId: number, event: Row, already: Set<string>) {
  const subject = event.subject;
  const live = rows(draft.view, "runs", { lane: subject, state: ["queued", "claimed"] });
  for (const run of live) {
    if (already.has(run.rule)) continue;
    const rule = ruleNamed(draft, run.rule);
    if (!rule) continue;
    const known = rows(draft.view, "run_events", { run_id: run.id, event_id: eventId });
    if (known.length) continue;
    // Context, not a matching event of this rule: it is read, but never becomes authority for its work.
    put(draft, "run_events", `${run.id}:${eventId}`, { run_id: run.id, event_id: eventId, context: 1 });
  }
}

function runAttachment(draft: Draft, id: number, token: string, attachment: string) {
  const run = heldRun(draft, id, token, ["claimed", "unknown"]);
  const found = eventsOf(draft.view, run.id).some((event: Row) =>
    (event.attachments ?? []).some((one: { id: string }) => one.id === attachment),
  );
  if (!found) throw new NotFound("这一轮没有这个附件");
  return true;
}

function heldRun(draft: Draft, id: number, token: string, states: string[]) {
  const run = draft.view.get("runs", id);
  const issued = run && states.includes(run.state) && run.issued !== null;
  if (!issued || credential(draft.env, "run", id, run.issued) !== token) throw new AuthError("这件活不归这个令牌");
  return run;
}

function cardFromReceipt(draft: Draft, run: Row, kind: string, card: Row) {
  const name = card.key ?? digest(`${card.title}\n${card.text}`).slice(0, 32);
  const session = draft.view.get("runs", run.id)!.session;
  const fyi = kind === "notice" && card.fyi === true;
  const quiet = kind === "notice" && ruleNamed(draft, run.rule)?.tell === "never";
  const origin = { source: sourceOf(draft.view, run.id), agent: run.agent, session, run: run.id };
  const reply = replyOf(draft.view, run.id);
  const key = `thread:${run.rule}:${run.lane}:${name}`;
  // Closed as it's made, nothing open stops it coming again: a run trying again says it once.
  if (fyi && rows(draft.view, "cards", { key, run_id: run.id }, 1).length) return;
  createCard(draft, {
    ...card,
    hops: hopsOf(draft, run),
    key,
    kind,
    fyi,
    quiet,
    ...threadOf(run),
    ...origin,
    ...(reply && { reply }),
  });
}

/** Notices what has gone quiet: a worker that stopped coming, a run its worker stopped mentioning. */
function sweep(draft: Draft) {
  const { now } = draft;
  for (const worker of workers(draft.view)) {
    const seen = draft.view.get("seen", `worker:${worker}`);
    const lastSeen = seen ? Date.parse(seen.seen_at) : undefined;
    if (lastSeen !== undefined && now - lastSeen <= WORKER_FRESH) {
      closeOffline(draft, worker);
      const inDoubt = (run: Row) => workerOf(draft.view, run) === worker && Date.parse(run.seen_at) < now - RUN_LEASE;
      for (const run of rows(draft.view, "runs", { state: "claimed" }).filter(inDoubt)) {
        put(draft, "runs", run.id, { state: "unknown" });
        const agent = configuration(draft.view, run.rules_version).agents[run.agent].name;
        const words = `交给 ${agent} 后超过 5 分钟没有回音，不确定做没做完；后续新任务照常处理。`;
        notify(draft, `run:${run.id}:unknown`, run.rule, words, noticeTarget(draft, run));
      }
    }
    const waiting = waitingOn(draft.view, worker, now);
    if (!waiting.length) continue;
    const since = now - (lastSeen ?? Date.parse(waiting[0].created_at));
    const { key, told } = offlineCard(draft.view, worker, waiting);
    if (since <= OFFLINE_AFTER || told) continue;
    const minutes = Math.floor(since / MINUTE);
    const neverSeen = lastSeen === undefined;
    const situation = neverSeen
      ? `${worker} 一直没连上中台，有 ${waiting.length} 件任务等了 ${minutes} 分钟没人接`
      : `${worker} 已经 ${minutes} 分钟没连上中台，有 ${waiting.length} 件任务在排队或在跑`;
    const check = neverSeen ? "有没有开机联网" : "是不是关机、休眠或断网了";
    notify(draft, key, "接单程序没连上", `${situation}（请看一眼那台电脑${check}）。`);
  }
}

function claimNext(draft: Draft, worker: string, claim: string) {
  const agents = agentsOf(draft.view, worker);
  const runs = rows(draft.view, "runs", { state: ["queued", "claimed"] });
  const claimed = runs.filter((run) => run.state === "claimed");
  const groupLimit = (group: string) =>
    group === "dispatch" ? 1 : (draft.rules.rules.find((rule) => rule.group === group)?.parallel ?? 1);
  const claimable = (run: Row) => {
    if (run.state !== "queued") return false;
    // A dispatcher round has no rule of its own: it belongs to the Agent it was queued for and is not held by a pause.
    const rule = run.kind === "dispatch" ? undefined : ruleNamed(draft, run.rule);
    // An ordinary round queued before a rules change still belongs to the rule's current agent; a kinded round belongs to
    // the agent it was queued for.
    const agent = run.kind ? run.agent : rule?.to;
    // What was queued before a pause, or an answer that came in during one, waits for the resume.
    if (!agent || !agents.includes(agent)) return false;
    if (rule && pauseOf(draft.view, rule, draft.now)) return false;
    const agentLimit = draft.rules.agents[agent]?.maxActive;
    return (
      Date.parse(run.not_before) <= draft.now &&
      !claimed.some((other) => other.grp === run.grp && other.lane === run.lane) &&
      claimed.filter((other) => other.grp === run.grp).length < groupLimit(run.grp) &&
      (!rule ||
        rule.maxActive === undefined ||
        claimed.filter((other) => other.rule === run.rule).length < rule.maxActive) &&
      (agentLimit === undefined || claimed.filter((other) => other.agent === agent).length < agentLimit)
    );
  };
  // The same claim again means the answer got lost: it gets back the run it already has.
  const held = claimed.find((run) => run.claim === claim && workerOf(draft.view, run) === worker);
  const run = held ?? runs.find(claimable);
  if (!run) return null;
  let rules_version = held ? run.rules_version : draft.view.get("config", "rules")!.version;
  if (!held) {
    // A speculative or assessor round belongs to whoever it was queued for; only an ordinary round follows the rule's agent.
    if (!run.kind) {
      assignQueued(draft, run);
      settleSession(draft, draft.view.get("runs", run.id)!);
      // A run queued under old rules takes the configuration it is claimed under, as it always has.
      rules_version = draft.view.get("config", "rules")!.version;
    }
  }
  const since = held ? { claimed_at: run.claimed_at, link: run.link } : { claimed_at: draft.at, link: null };
  const claiming = { state: "claimed", claim, issued: draft.seq, seen_at: draft.at, rules_version, ...since };
  put(draft, "runs", run.id, { ...claiming, ...nulls("last_issued", "last_result", "last_answer") });
  if (run.kind === "dispatch")
    for (const event of assessedEventsOf(draft, draft.view.get("runs", run.id)!))
      put(draft, "events", event.id, { dispatch_run: run.id, dispatch_state: "running" });
  return jobOf(draft.view, draft.view.get("runs", run.id)!, draft.env, draft.now);
}

/** Ends a run nothing will pick up again, and says so. */
function stopRun(draft: Draft, run: Row, why: string, summary: string, words: string) {
  put(draft, "runs", run.id, { state: "cancelled", finished_at: draft.at, summary });
  closeStopped(draft, run.id, summary);
  notify(draft, `run:${run.id}:${why}`, run.rule, words, noticeTarget(draft, run));
  if (run.kind === "assess")
    markAssessmentUnavailable(draft, run, why === "rule-gone" ? "rule_gone" : "assessment_stopped");
}

const ruleGone = (run: Row): [string, string] => [
  `规则「${run.rule}」不在了，不再派发`,
  `规则「${run.rule}」不在了（删掉或改名了），排着的这一轮不再派发。还要做的话重新触发这件事。`,
];

/** A run that didn't get through waits to try again, and takes along whatever came in for the same thing meanwhile. */
function retryLater(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const attempts = run.attempts + 1;
  const notBefore = draft.now + Math.min(5 * MINUTE * 2 ** (attempts - 1), 60 * MINUTE);
  const error = (result.error ?? "").trim().replace(/[。.]+$/, "") || "没说原因";
  const unclaimed = nulls("claim", "claimed_at", "seen_at", "cancel_at");
  const rejected: Rejected[] = [];
  for (const what of ["ask", "resolve", "later", "events"] as const) {
    for (const _ of result[what] ?? []) rejected.push({ what, reason: "没跑成的一轮只能发通知" });
  }
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  const failure = { attempts, error, ...unclaimed };
  if (!ruleNamed(draft, run.rule)) {
    put(draft, "runs", id, failure);
    stopRun(draft, run, "rule-gone", ...ruleGone(run));
    return rejected;
  }
  if (attempts >= MAX_ATTEMPTS) {
    // Runs queued for this thread stay apart: they came in since, and get their own count and their own go.
    const summary = `连续 ${MAX_ATTEMPTS} 次没跑成，不再自动重试`;
    const words = `连续 ${MAX_ATTEMPTS} 次自动处理没跑完（卡在：${error}），不再自动重试。解决后重新触发这件事，它会从头开始。`;
    // The more specific terminal reason comes first: stopping then settles the same assessment and must not add another.
    if (run.kind === "assess") markAssessmentUnavailable(draft, run, "assessment_failed");
    put(draft, "runs", id, failure);
    stopRun(draft, run, "stopped", summary, words);
    return rejected;
  }
  put(draft, "runs", id, { state: "queued", not_before: iso(notBefore), ...failure });
  // Only a round of the same kind and agent can take over what came in meanwhile: an assessor's retry is not the work itself.
  const waiting = rows(draft.view, "runs", { rule: run.rule, lane: run.lane, state: "queued" }).filter(
    (other) => other.agent === run.agent && (other.kind ?? null) === (run.kind ?? null),
  );
  for (const other of waiting.filter((other) => other.id !== id)) {
    for (const link of rows(draft.view, "run_events", { run_id: other.id })) {
      // Context stays context: moving the link must not turn material into work this rule took.
      put(draft, "run_events", `${id}:${link.event_id}`, {
        run_id: id,
        event_id: link.event_id,
        ...(link.context && { context: link.context }),
      });
      set(draft, "run_events", `${other.id}:${link.event_id}`, null);
      // An assessor or speculative round was not the rule's work: merging its queue must not mark the event dispatched.
      if (!run.kind && !link.context) markDispatched(draft, link.event_id, run.rule);
    }
    set(draft, "runs", other.id, null);
    if (other.resume) put(draft, "runs", id, { resume: other.resume });
  }
  if (!result.notice?.some((notice) => !notice.fyi)) {
    const clock = { timeZone: draft.rules.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Intl.DateTimeFormat("zh-CN", clock).format(notBefore);
    const words =
      attempts === 1
        ? `这一轮没跑完（卡在：${error}），${time} 会自动再试。`
        : `连续 ${attempts} 次自动处理没跑完（卡在：${error}），${time} 会自动再试。`;
    notify(draft, `run:${id}:failing`, run.rule, words, noticeTarget(draft, run));
  }
  if (!run.kind) assignQueued(draft, draft.view.get("runs", id)!);
  return rejected;
}

function scheduleReview(draft: Draft, run: Row, later: Later) {
  const { rule, lane } = run;
  const [existing] = rows(draft.view, "timers", { rule, lane, key: later.key, event_id: null });
  if (later.cancel) {
    if (existing) set(draft, "timers", existing.id, null);
    return;
  }
  const session = draft.view.get("runs", run.id)!.session;
  const fields = {
    at: iso(Date.parse(later.at!)),
    about: later.about,
    session,
    agent: run.agent,
    hops: hopsOf(draft, run),
    ...(replyOf(draft.view, run.id) && { reply: replyOf(draft.view, run.id) }),
  };
  if (existing) return void put(draft, "timers", existing.id, fields);
  const source = sourceOf(draft.view, run.id) ?? SCHEDULE;
  add(draft, "timers", { ...fields, rule, lane, key: later.key, source, event_id: null, created_at: draft.at });
}

/**
 * A speculative round's result: worth delivering becomes an ordinary round on the same events, so the real work and its
 * receipt still run once. A round that found nothing ends quietly, without a card or a notice.
 */
function applySpeculation(draft: Draft, run: Row, result: Result): Rejected[] {
  const id = run.id;
  const rule = ruleNamed(draft, run.rule);
  put(draft, "runs", id, {
    state: result.outcome,
    finished_at: draft.at,
    summary: result.summary ?? "",
    error: null,
    cancel_at: null,
  });
  closeOpen(draft, (key) => key === `run:${id}:failing`, "后来跑成了");
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "结果回来了");
  if (!rule) return [];
  // Only a try that can be handed over is worth a real round: blocked, failed or dropped stays in the record only.
  const worth = result.outcome === "done" && ["ready", "progress"].includes(result.report?.state ?? "");
  if (!worth) return [];
  // Context is material for the speculative try; it is not the work the real round was asked to take.
  for (const event of takenEventsOf(draft.view, id)) {
    const queued = enqueue(draft, rule, event.id, run.lane, null, false, false);
    if (queued === null) continue;
    // The latest accept is the one that matters: an assessor's verdict may have replaced the gate's first decision, and the
    // try only proves it is worth acting on now.
    const [decision] = rows(draft.view, "decisions", { event_id: event.id, rule: rule.name, state: "accept" }, 1, true);
    dispatch(
      draft,
      event.id,
      rule,
      {
        state: "accept",
        strength: (decision?.strength as "explicit" | "inferred") ?? "explicit",
        reason: (decision?.reason as string) ?? "source_key",
      },
      decision?.scope as string | undefined,
    );
  }
  return [];
}

function applyAssessment(draft: Draft, run: Row, result: Result): Rejected[] {
  const id = run.id;
  put(draft, "runs", id, {
    state: result.outcome,
    finished_at: draft.at,
    summary: result.summary ?? "",
    error: null,
    cancel_at: null,
  });
  closeOpen(draft, (key) => key === `run:${id}:failing`, "后来跑成了");
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "结果回来了");
  // The verdict is about a rule that may have been removed while the assessor was reading.
  if (!ruleNamed(draft, run.rule)) {
    markAssessmentUnavailable(draft, run, "rule_gone");
    return [];
  }
  if (!result.verdict) {
    // Without a verdict the rule takes nothing: the event is left for a person to look at, not retried for ever.
    markAssessmentUnavailable(draft, run, "no_verdict");
    return [];
  }
  applyVerdict(draft, run, result.verdict);
  return [];
}

/** An assessment that cannot decide leaves each event unavailable: recorded, refused for the rule, and never retried. */
function markAssessmentUnavailable(draft: Draft, run: Row, reason: string) {
  const ruleName = run.rule;
  for (const event of assessedEventsOf(draft, run)) {
    // One terminal verdict per event and rule: a retry's last failure and the stop that follows must not both settle it.
    const existing = rows(draft.view, "decisions", { event_id: event.id, rule: ruleName });
    if (existing.some((decision) => decision.state === "unavailable")) continue;
    add(draft, "decisions", {
      event_id: event.id,
      rule: ruleName,
      source: event.source,
      actor: event.actor ?? "",
      state: "unavailable",
      reason,
      rules_version: draft.view.get("config", "rules")!.version,
      decided_at: draft.at,
    });
    const refused = JSON.parse(draft.view.get("events", event.id)!.refused ?? "[]") as string[];
    put(draft, "events", event.id, { refused: JSON.stringify([...new Set([...refused, ruleName])]) });
  }
}

function applyReceipt(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const rule = ruleNamed(draft, run.rule);
  const summary = result.summary ?? "";
  const rejected: Rejected[] = [];
  put(draft, "runs", id, {
    state: result.outcome,
    finished_at: draft.at,
    summary,
    error: null,
    cancel_at: null,
    ...(result.report && { report: JSON.stringify(result.report) }),
  });
  closeOpen(draft, (key) => key === `run:${id}:failing`, "后来跑成了");
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "结果回来了");
  const eventIds = takenEventsOf(draft.view, id).map((event) => event.id);
  for (const card of rows(draft.view, "cards", { answer_event: eventIds, state: "decided" })) {
    put(draft, "cards", card.id, { state: "done", result: summary, closed_at: draft.at, version: card.version + 1 });
  }
  for (const item of result.resolve ?? []) {
    const card = openInScope(draft.view, run).find((card) => card.id === item.card);
    if (card) closeCard(draft, card, item.reason.trim(), `第 ${id} 轮`);
    else rejected.push({ card: item.card, reason: "不在本轮核对范围" });
  }
  for (const ask of result.ask ?? []) cardFromReceipt(draft, run, "ask", ask);
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  if (rule?.tell === "always" && result.outcome === "done") {
    const reply = replyOf(draft.view, id);
    const once = {
      fyi: true,
      once: true,
      ...threadOf(run),
      source: sourceOf(draft.view, id),
      run: id,
      ...(reply && { reply }),
    };
    notify(draft, `run:${id}:done`, run.rule, summary, once);
  }
  for (const later of result.later ?? []) scheduleReview(draft, run, later);
  const emitted: number[] = [];
  for (const event of result.events ?? []) {
    if (rule?.emits && typeMatches(rule.emits.types, event.type)) {
      const sent = ingest(draft, rule.emits.source, { ...event, hops: hopsOf(draft, run) + 1 }, false, "rule");
      // A number already taken is an earlier event's, perhaps another source's: what it says isn't what this receipt sent.
      if (!sent.duplicate) emitted.push(sent.event);
    } else rejected.push({ what: "events", reason: `规则「${run.rule}」没有写可以发 ${event.type}` });
  }
  // The source whose event this run took reads them back (`eventOutcome`); nothing else links them to the run.
  if (emitted.length) put(draft, "runs", id, { emitted: JSON.stringify(emitted) });
  return rejected;
}

function finish(draft: Draft, id: number, token: string, given: unknown) {
  const hash = digest(JSON.stringify(given ?? null));
  const prior = draft.view.get("runs", id);
  // The same execution handing in again means the answer got lost: it gets the same answer, and nothing happens twice.
  if (prior && prior.last_issued !== null && credential(draft.env, "run", id, prior.last_issued) === token) {
    if (prior.last_result !== hash) throw new Conflict("这一次执行已经交过不一样的结果");
    return { rejected: JSON.parse(prior.last_answer ?? "[]"), duplicate: true };
  }
  const run = heldRun(draft, id, token, ["claimed", "unknown"]);
  const result = parseResult(given);
  const session = result.session ?? run.session;
  const usage = result.usage
    ? JSON.stringify(addUsage(run.usage ? JSON.parse(run.usage) : undefined, result.usage))
    : run.usage;
  put(draft, "runs", id, { last_issued: run.issued, last_result: hash, issued: null, session, usage });
  let rejected: Rejected[] = [];
  // A dispatcher round that did not finish has no retry: the event is recorded, and a person gets the card to place it.
  if (run.kind === "dispatch" && result.outcome !== "done" && result.outcome !== "nothing") {
    put(draft, "runs", id, {
      state: result.outcome,
      finished_at: draft.at,
      summary: result.summary ?? "",
      error: result.error ?? null,
    });
    const [event] = assessedEventsOf(draft, run);
    if (event) {
      recordDispatch(draft, run, event, "failed", undefined, result.error ?? result.summary ?? "调度没跑成");
      unassigned(draft, event, run, `调度没跑成：${result.error ?? result.summary ?? "没有说明"}`);
    }
    put(draft, "runs", id, { last_answer: "[]" });
    return { rejected: [] };
  }
  // Told to stop, one that failed first has stopped all the same: trying again would start what the owner ended.
  if (result.outcome === "cancelled" || (result.outcome === "failed" && run.cancel_at)) {
    put(draft, "runs", id, {
      state: "cancelled",
      finished_at: draft.at,
      summary: result.summary ?? "",
      cancel_at: null,
    });
    closeStopped(draft, id, "已停止");
    if (run.kind === "assess") markAssessmentUnavailable(draft, run, "assessment_cancelled");
  } else if (result.outcome === "failed") rejected = retryLater(draft, run, result);
  else if (run.kind === "assess") rejected = applyAssessment(draft, run, result);
  else if (run.kind === "dispatch") rejected = applyRoute(draft, run, result);
  else if (run.kind === "speculate") rejected = applySpeculation(draft, run, result);
  else rejected = applyReceipt(draft, run, result);
  put(draft, "runs", id, { last_answer: JSON.stringify(rejected) });
  return { rejected };
}

function answer(draft: Draft, id: number, given: Row) {
  const card = draft.view.get("cards", id);
  if (!card) throw new NotFound("没有这张卡片");
  if (given.channel !== undefined) {
    const allowed = draft.rules.channels[given.channel]?.answerers;
    if (allowed && !allowed.includes(given.by ?? "")) throw new AuthError("这个人不能回答这张卡片");
    const delivery = draft.view.get("deliveries", `${id}:${given.channel}`);
    if (!delivery?.ref || delivery.ref !== given.ref) throw new AuthError("不是发出去的那条消息");
  }
  if (card.state !== "open") return { changed: false, state: card.state };
  if (given.by !== undefined && (typeof given.by !== "string" || [...given.by].length > ANSWER_BY)) {
    throw new InputError(`回答人最多 ${ANSWER_BY} 字`);
  }
  if (given.ref !== undefined && (typeof given.ref !== "string" || [...given.ref].length > ANSWER_REF)) {
    throw new InputError(`消息编号最多 ${ANSWER_REF} 字`);
  }
  const words = card.kind === "notice" ? "处理说明" : "回答";
  if (given.text !== undefined && typeof given.text !== "string") throw new InputError(`${words}要是文字`);
  const text = given.text?.trim() || null;
  if (text !== null && [...text].length > ANSWER_TEXT) throw new InputError(`${words}最多 ${ANSWER_TEXT} 字`);
  if (card.kind === "notice") {
    closeCard(draft, card, "已处理", given.by ?? null, text);
    return { changed: true, state: "closed" };
  }
  const optionCount = JSON.parse(card.options).length;
  const inRange = Number.isInteger(given.choice) && given.choice >= 0 && given.choice < optionCount;
  if (given.choice === undefined ? !text : !inRange) throw new InputError("没有这个选项");
  // A card the hub made to place an event is answered by the hub itself: the chosen project is checked and dispatched.
  if (card.grp === "dispatch" && card.run_id !== null) {
    const options: string[] = JSON.parse(card.options);
    const choice = given.choice === undefined ? text : options[given.choice];
    const run = draft.view.get("runs", card.run_id);
    const [event] = run ? assessedEventsOf(draft, run) : [];
    if (!event) throw new Conflict("这张卡片对应的事件已经不在了");
    if (choice === "先放着") {
      closeCard(draft, card, "先放着", given.by ?? null, text);
      put(draft, "events", event.id, { dispatch_state: "unassigned" });
      return { changed: true, state: "closed" };
    }
    if (choice === "知道了") {
      closeCard(draft, card, "知道了", given.by ?? null, text);
      put(draft, "events", event.id, { dispatch_state: "unassigned" });
      return { changed: true, state: "closed" };
    }
    const project = choice ?? "";
    if (!projectChoices(draft, event).includes(project)) throw new InputError("没有这个项目");
    const problem = placeEvent(draft, event, project, "continue", "person");
    if (problem) throw new Conflict(problem);
    const suggested = rows(draft.view, "dispatch_decisions", { event_id: event.id }, 1, true)[0]?.project;
    if (suggested && suggested !== project) {
      add(draft, "dispatch_corrections", {
        event_id: event.id,
        suggested,
        chosen: project,
        source: event.source,
        actor: event.actor ?? "",
        lane: event.subject,
        reason: "本人选了另一个项目",
        created_at: draft.at,
      });
      const preference = rows(draft.view, "dispatch_preferences", {
        project,
        source: event.source,
        actor: event.actor ?? "",
      })[0];
      if (preference)
        put(draft, "dispatch_preferences", preference.id, {
          ...preference,
          reason: "本人纠正过调度",
          confirmations: (preference.confirmations ?? 0) + 1,
          active: 1,
          updated_at: draft.at,
        });
      else
        add(draft, "dispatch_preferences", {
          project,
          source: event.source,
          actor: event.actor ?? "",
          reason: "本人纠正过调度",
          confirmations: 1,
          active: 1,
          created_at: draft.at,
          updated_at: draft.at,
        });
    }
    closeCard(draft, card, `已放到 ${project}`, given.by ?? null, text);
    return { changed: true, state: "closed" };
  }
  const rule = card.rule ? ruleNamed(draft, card.rule) : undefined;
  const { lane: subject, title: summary, hops = 0 } = card;
  const event = {
    id: `card:${id}`,
    type: "card.answered",
    subject,
    summary,
    hops,
    ...(card.reply && { reply: card.reply }),
  };
  const eventId = recordEvent(draft, card.source ?? SCHEDULE, event, rule ? [rule.name] : []);
  const decision = { choice: given.choice ?? null, answer: text, by: given.by ?? null, decided_at: draft.at };
  put(draft, "cards", id, { state: "decided", ...decision, answer_event: eventId, version: card.version + 1 });
  if (rule) {
    const run = enqueue(draft, rule, eventId, card.lane, card.agent === rule.to ? card.session : null, true);
    if (run !== null)
      dispatch(draft, eventId, rule, { state: "accept", strength: "explicit", reason: "person" }, undefined, false);
  }
  return { changed: true, state: "decided" };
}

function nextCard(draft: Draft, channel: string) {
  const { now } = draft;
  for (const card of draft.view.deliveryCandidates(channel, now)) {
    const reach = (card.rule ? ruleNamed(draft, card.rule)?.channels : undefined) ?? draft.rules.defaultChannels;
    if (reach && !reach.includes(channel)) continue;
    const key = `${card.id}:${channel}`;
    const delivery = draft.view.get("deliveries", key) ?? NOT_DELIVERED;
    const recentNote = card.fyi && Date.parse(card.created_at) >= now - 24 * 60 * MINUTE;
    const worthSending = card.state === "open" || delivery.ref !== null || recentNote;
    const resting = delivery.not_before && Date.parse(delivery.not_before) > now;
    if (card.quiet || delivery.version >= card.version || delivery.given_up || resting || !worthSending) continue;
    const firstTry = delivery.first_try_at;
    if (delivery.tries >= RESEND_AT.length || (firstTry && now - Date.parse(firstTry) > RESEND_WINDOW)) {
      put(draft, "deliveries", key, { given_up: 1 });
      continue;
    }
    const attempt = { tries: delivery.tries + 1, first_try_at: firstTry ?? draft.at, not_before: iso(now + MINUTE) };
    put(draft, "deliveries", key, { card_id: card.id, channel, ...attempt });
    return cardView(card, draft.env, delivery.ref, draft.rules.channels[channel]?.links === true);
  }
  return null;
}

/** What the clock has brought: schedules come round, reviews come due, and anything gone quiet. */
function tick(draft: Draft) {
  const { now } = draft;
  const { rules, timezone } = draft.rules;
  for (const pause of rows(draft.view, "pauses")) {
    if (pause.until === null || Date.parse(pause.until) > now) continue;
    set(draft, "pauses", pause.name, null);
    reopen(draft, pause.name, Date.parse(pause.until));
  }
  for (const rule of rules) {
    if (eventRule(rule)) continue;
    const text = cronOf(rule);
    const cron = parseCron(text)!;
    const schedule = draft.view.get("schedules", rule.name);
    const nextAt = () => iso(nextRun(cron, now, timezone)!);
    if (!schedule || schedule.cron !== text) {
      put(draft, "schedules", rule.name, { rule: rule.name, cron: text, next_at: nextAt() });
      continue;
    }
    if (now < Date.parse(schedule.next_at)) continue;
    const slot = iso(latestBefore(cron, Date.parse(schedule.next_at), now, timezone));
    // Paused, the moment passes without a run, and the next one is the next one: a resume owes nothing.
    if (pauseOf(draft.view, rule, now)) {
      put(draft, "schedules", rule.name, { next_at: nextAt(), skipped_at: slot });
      continue;
    }
    const key = `${rule.name}@${slot}`;
    if (!rows(draft.view, "events", { source: SCHEDULE, key }).length) {
      const eventId = recordEvent(draft, SCHEDULE, { id: key, type: "schedule.tick" }, [rule.name]);
      const run = enqueue(draft, rule, eventId, "");
      if (run !== null) dispatch(draft, eventId, rule, { state: "accept", strength: "explicit", reason: "schedule" });
    }
    put(draft, "schedules", rule.name, { next_at: nextAt() });
  }
  const due = rows(draft.view, "timers", { event_id: null }).filter((timer) => Date.parse(timer.at) <= now);
  for (const timer of due.sort((a, b) => a.at.localeCompare(b.at))) {
    const rule = ruleNamed(draft, timer.rule);
    const event = {
      id: `timer:${timer.id}`,
      type: "timer.due",
      subject: timer.lane,
      hops: timer.hops ?? 0,
      ...(timer.reply && { reply: timer.reply }),
    };
    const eventId = recordEvent(draft, timer.source, event, rule ? [rule.name] : []);
    put(draft, "timers", timer.id, { event_id: eventId });
    if (rule) {
      const run = enqueue(draft, rule, eventId, timer.lane, timer.agent === rule.to ? timer.session : null);
      if (run !== null) dispatch(draft, eventId, rule, { state: "accept", strength: "explicit", reason: "timer" });
    }
  }
  sweep(draft);
}

/** A schedule whose next moment passed while paused starts again at the first moment from `from`, not with a backlog. */
function reopen(draft: Draft, name: string, from: number) {
  const rule = draft.rules.rules.find((rule) => rule.name === name);
  if (!rule || eventRule(rule)) return;
  const schedule = draft.view.get("schedules", rule.name);
  if (!schedule || Date.parse(schedule.next_at) >= from) return;
  const next = nextRun(parseCron(cronOf(rule))!, from - 1, draft.rules.timezone);
  put(draft, "schedules", rule.name, { next_at: iso(next!) });
}

function knownRule(draft: Draft, name: string) {
  // Not ruleNamed: a task elsewhere that can ask goes on like a rule, but the hub neither starts nor holds it.
  const rule = draft.rules.rules.find((rule) => rule.name === name);
  if (rule) return rule;
  if (draft.rules.elsewhere.some((task) => task.name === name)) {
    throw new InputError(`「${name}」是在别处跑的定时任务，中台不启动它，也就停不了、跑不了`);
  }
  throw new NotFound(`没有这条规则：${name}`);
}

const PAUSE_REASON = 500;
function pauseFields(draft: Draft, given: Row) {
  const { reason = "", until = null } = given ?? {};
  if (typeof reason !== "string" || [...reason].length > PAUSE_REASON) {
    throw new InputError(`暂停原因要是 ${PAUSE_REASON} 字以内的文字`);
  }
  const ends = typeof until === "string" && /(Z|[+-]\d\d:\d\d)$/.test(until) ? Date.parse(until) : NaN;
  if (until !== null && !(ends > draft.now)) throw new InputError("until 要是带时区、晚于现在的 ISO 时间");
  return { reason: reason.trim(), until: until === null ? null : iso(ends) };
}

const pauseView = ({ by, reason, since, until }: Row) => ({ by, reason, since, until });

/** Owner actions on one rule. They are facts in the log, not edits to rules.json. */
const CONTROL = {
  pauseRule(draft: Draft, name: string, by: string, given: Row) {
    knownRule(draft, name);
    const fields = pauseFields(draft, given);
    const existing = draft.view.get("pauses", name);
    const same = existing && existing.reason === fields.reason && existing.until === fields.until;
    if (!same) put(draft, "pauses", name, { name, by, since: existing?.since ?? draft.at, ...fields });
    return { changed: !same, rule: name, paused: pauseView(draft.view.get("pauses", name)!) };
  },
  resumeRule(draft: Draft, name: string) {
    // A rule taken out of rules.json while paused can still have its pause lifted.
    const pause = draft.view.get("pauses", name);
    if (!pause) {
      knownRule(draft, name);
      return { changed: false, rule: name };
    }
    set(draft, "pauses", name, null);
    reopen(draft, name, draft.now);
    // Which pause it was: what it skipped is read from when it began, and once it's gone nothing else says when.
    return { changed: true, rule: name, paused: pauseView(pause) };
  },
  /** Events a pause kept from the rule, taken by it now as they would have been then: each once, never while paused. */
  replayRule(draft: Draft, name: string, events: number[]) {
    const rule = knownRule(draft, name);
    if (!eventRule(rule))
      throw new InputError(`「${name}」是定时规则，暂停时到点不跑、不记事件，没有可补跑的；要补一轮用 run`);
    if (pauseOf(draft.view, rule, draft.now)) throw new Conflict(`规则「${name}」暂停中，先恢复再补跑`);
    // An event stays as it came, still saying which pauses skipped it. What says it's been made up is a run of this rule
    // holding it, and a link once made only ever moves to another run of the same rule and matter.
    const taken = (id: number) =>
      rows(draft.view, "run_events", { event_id: id }).some(
        (link) => draft.view.get("runs", link.run_id)?.rule === name,
      );
    const replayed: number[] = [];
    const runs = new Set<number>();
    for (const id of [...events].sort((a, b) => a - b)) {
      const event = draft.view.get("events", id);
      // A pause is not a way around the gate: an event the policy refused stays refused.
      if (
        !event ||
        !JSON.parse(event.paused ?? "[]").includes(name) ||
        JSON.parse(event.refused ?? "[]").includes(name) ||
        taken(id)
      )
        continue;
      const run = enqueue(draft, rule, id, rule.parallel ? event.subject : "");
      if (run === null) continue;
      dispatch(draft, id, rule, { state: "accept", strength: "explicit", reason: "replay" });
      runs.add(run);
      replayed.push(id);
    }
    return { events: replayed, runs: [...runs] };
  },
  /** One run now, through the usual queue, from an event of its own that says the owner asked for it. */
  runRule(draft: Draft, name: string, by: string, given: Row) {
    const rule = knownRule(draft, name);
    const { subject = "", reason = "" } = given ?? {};
    if (typeof reason !== "string" || [...reason].length > PAUSE_REASON) {
      throw new InputError(`说明要是 ${PAUSE_REASON} 字以内的文字`);
    }
    if (pauseOf(draft.view, rule, draft.now)) throw new Conflict(`规则「${name}」暂停中，先恢复再手动运行`);
    const source = eventRule(rule) ? rule.when.source : SCHEDULE;
    // The same checks as any event: its subject becomes the lane and goes into the prompt.
    const event = parseEvent({
      id: `manual:${draft.seq}`,
      type: "run.manual",
      subject,
      summary: `${by} 手动运行`,
      detail: reason,
    });
    const eventId = recordEvent(draft, source, event, [name]);
    const run = enqueue(draft, rule, eventId, rule.parallel ? subject : "", null, true);
    if (run === null) throw new Conflict(`规则「${name}」的事项在等本人处理，先回答它`);
    dispatch(draft, eventId, rule, { state: "accept", strength: "explicit", reason: "manual" });
    // Waiting out a retry's backoff wouldn't be now: the owner asking is the go-ahead.
    put(draft, "runs", run, { manual: 1, not_before: draft.at });
    return { event: eventId, run };
  },
};

/** Every input there is, each with its arguments named. What one returns is what the caller is told. */
const HANDLERS: Record<string, (draft: Draft, ...args: any[]) => unknown> = {
  rules(draft, rules) {
    put(draft, "config", "rules", { value: rules, version: draft.seq });
    for (const run of rows(draft.view, "runs", { state: "queued" })) {
      if (ruleOf(rules, run.rule)) assignQueued(draft, run);
      else stopRun(draft, run, "rule-gone", ...ruleGone(run));
    }
    closeOpen(draft, (key) => key.startsWith("rules:"), "改好了");
  },
  rulesError: (draft, problem) => notify(draft, `rules:${digest(problem)}`, "rules.json 写错了，还在用旧规则", problem),
  key: (draft, kind, name, hash) =>
    void put(draft, "keys", `${kind}:${name}`, { kind, name, hash, created_at: draft.at }),
  removeKey: (draft, kind, name) => {
    if (!draft.view.get("keys", `${kind}:${name}`)) return false;
    set(draft, "keys", `${kind}:${name}`, null);
    return true;
  },
  ingest: (draft, source, given) => ingest(draft, source, given, true),
  createCard,
  /** A task elsewhere asks you; your answer goes on like a round of a rule, where its cwd says. */
  ask(draft, name, given) {
    const task = draft.rules.elsewhere.find((task) => task.name === name)!;
    if (!task.cwd) throw new InputError(`定时任务「${name}」没写 cwd，回答了没人接着做：只能 tell`);
    const { key, ...question } = given;
    const matter = key ?? digest(`${question.title}\n${question.text}`).slice(0, 32);
    const thread = { rule: name, lane: "", grp: name, source: task.source, agent: task.to };
    // A key of its own: told once for good, a notice under the same key would never get through after a question.
    return createCard(draft, { ...question, key: `elsewhere-ask:${name}:${matter}`, kind: "ask", ...thread });
  },
  tell(draft, key, title, text) {
    const told = createCard(draft, { key, title, text, kind: "notice", fyi: true, once: true });
    if (!told.duplicate) return told;
    // Said again after every channel gave up on it: it gets another go.
    const givenUp = rows(draft.view, "deliveries", { card_id: told.card, given_up: 1 });
    for (const { card_id, channel } of givenUp) {
      put(draft, "deliveries", `${card_id}:${channel}`, { given_up: 0, ...NOT_TRYING });
    }
    if (!givenUp.length) return told;
    put(draft, "cards", told.card, { text, created_at: draft.at });
    return { ...told, duplicate: false };
  },
  heartbeat(draft, worker, running) {
    closeOffline(draft, worker);
    const held = (run?: Row) => run?.state === "claimed" && workerOf(draft.view, run) === worker;
    const inHand = running.map((id: number) => draft.view.get("runs", id)).filter(held);
    // All stamped together, so however many runs a worker has on, it's one fact each time.
    if ([draft.view.get("seen", `worker:${worker}`), ...inHand].every((row) => justSeen(draft, row))) return;
    put(draft, "seen", `worker:${worker}`, { kind: "worker", name: worker, seen_at: draft.at });
    for (const run of inHand) put(draft, "runs", run.id, { seen_at: draft.at });
  },
  channelSeen(draft, name) {
    if (justSeen(draft, draft.view.get("seen", `channel:${name}`))) return;
    put(draft, "seen", `channel:${name}`, { kind: "channel", name, seen_at: draft.at });
  },
  claimNext,
  runAttachment,
  projectCreated(draft, eventId, project) {
    createdProject(draft, eventId, project);
  },
  projectCreationResult(draft, id, state, error) {
    const creation = draft.view.get("project_creations", id);
    if (!creation || creation.state !== "pending") return;
    put(draft, "project_creations", id, {
      state,
      error: error ?? null,
      applied_at: draft.at,
    });
  },
  projectCreationFailed(draft, eventId, reason) {
    let event = draft.view.get("events", eventId);
    if (!event || event.dispatch_state !== "creating") return;
    // The card may already exist from the proposal round; marking the state first keeps `unassigned` from overwriting it.
    put(draft, "events", eventId, { dispatch_state: "unassigned" });
    event = draft.view.get("events", eventId)!;
    const run = draft.view.get("runs", event.dispatch_run);
    if (run) unassigned(draft, event, run, reason || "新建项目失败");
    else
      notify(draft, `dispatch:${eventId}:create-failed`, "新建项目失败", reason || "新建项目失败", {
        once: true,
        ...(event.reply && { reply: event.reply }),
        ...(event.attachments && { attachments: event.attachments }),
      });
  },
  started(draft, id, token, given) {
    const { session, link } = given ?? {};
    for (const [field, value] of Object.entries({ session, link })) {
      if (value !== undefined && (typeof value !== "string" || value.length > 500)) {
        throw new InputError(`${field} 要是 500 字以内的文字`);
      }
    }
    const run = heldRun(draft, id, token, ["claimed"]);
    put(draft, "runs", id, { session: session ?? run.session, link: link ?? run.link, seen_at: draft.at });
  },
  progress(draft, id, token, given) {
    const run = heldRun(draft, id, token, ["claimed"]);
    const progress = parseProgress(given);
    const at = progress.at ?? draft.at;
    add(draft, "run_progress", {
      run_id: run.id,
      at,
      step: progress.step,
      detail: progress.detail ?? "",
      kind: progress.kind ?? "",
    });
    put(draft, "runs", id, { seen_at: draft.at });
  },
  finish,
  cancel(draft, id) {
    const run = draft.view.get("runs", id);
    if (!run) throw new NotFound("没有这一轮");
    if (run.state === "queued") {
      put(draft, "runs", id, { state: "cancelled", finished_at: draft.at });
      closeStopped(draft, id, "已停止");
      if (run.kind === "assess") markAssessmentUnavailable(draft, run, "assessment_cancelled");
    } else if (run.state === "claimed") put(draft, "runs", id, { cancel_at: draft.at });
    else throw new InputError("这一轮已经结束了");
  },
  resolve(draft, id, reason, by) {
    const card = draft.view.get("cards", id);
    if (!card) throw new NotFound("没有这张卡片");
    if (card.state !== "open") return false;
    closeCard(draft, card, reason, by);
    return true;
  },
  answer,
  nextCard,
  delivered(draft, channel, id, version, ref) {
    if (!draft.view.get("cards", id)) throw new NotFound("没有这张卡片");
    if (ref !== null && (typeof ref !== "string" || [...ref].length > DELIVERY_REF)) {
      throw new InputError(`消息编号最多 ${DELIVERY_REF} 字`);
    }
    const delivery = draft.view.get("deliveries", `${id}:${channel}`) ?? NOT_DELIVERED;
    const sent = { version: Math.max(delivery.version, version), ref: delivery.ref ?? ref };
    put(draft, "deliveries", `${id}:${channel}`, { card_id: id, channel, ...sent, ...NOT_TRYING, error: null });
  },
  failed(draft, channel, id, version, error) {
    const card = draft.view.get("cards", id);
    const delivery = draft.view.get("deliveries", `${id}:${channel}`);
    if (!card || !delivery) throw new NotFound("这张卡片没有交给这个通道");
    const firstTry = delivery.first_try_at ? Date.parse(delivery.first_try_at) : draft.now;
    const next =
      version < card.version
        ? { not_before: null }
        : delivery.tries >= RESEND_AT.length
          ? { given_up: 1 }
          : { not_before: iso(firstTry + RESEND_AT[delivery.tries] * MINUTE) };
    put(draft, "deliveries", `${id}:${channel}`, { ...next, error: String(error).slice(0, 300) });
  },
  sweep,
  tick,
  ...CONTROL,
};
