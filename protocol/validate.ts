// The protocol's own checks, with no state behind them: the hub applies them at its door, and a worker applies them to
// an Agent's receipt before handing it in, while the Agent can still be asked to write it again.
import { InputError } from "../kernel/errors.ts";

export const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** What the protocol allows a card answer to carry: the schema says so, and the hub keeps it. */
export const ANSWER_TEXT = 4000;
export const ANSWER_BY = 500;
export const ANSWER_REF = 500;
/** A channel's own reference to the message it sent. */
export const DELIVERY_REF = 500;
export type Later = { key: string; at?: string; about?: string; cancel?: boolean };
export type Ask = { title: string; text: string; options: string[]; recommend?: number; about?: string; key?: string };
export type Notice = { title: string; text: string; key?: string; fyi?: boolean };
export type Usage = { input?: number; output?: number; cached?: number; cost?: number };

/** Missing figures stay missing: zero is a price or token count that was actually reported. */
export function addUsage(total: Usage | undefined, more: Usage | undefined): Usage | undefined {
  if (!more) return total;
  const result = { ...total };
  for (const field of Object.keys(more) as (keyof Usage)[])
    if (more[field] !== undefined) result[field] = (result[field] ?? 0) + more[field];
  return result;
}
/** What a round says became of its work, in words a person's board reads: a stage, not a claim of success. */
export type Report = { state: "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped"; note?: string };
/** An assessor round's verdict on whether an event starts new work. Only an accepted one makes a ticket. */
export type Verdict = {
  decision: "accept" | "stop" | "ignore" | "unavailable";
  reason?: string;
  strength?: "explicit" | "inferred";
  scope?: string;
};

export type Result = {
  outcome: "done" | "nothing" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  session?: string;
  usage?: Usage;
  report?: Report;
  verdict?: Verdict;
  route?: Route;
  create?: Create;
  ask?: Ask[];
  notice?: Notice[];
  resolve?: { card: number; reason: string }[];
  later?: Later[];
  events?: EventInput[];
};

/** A step an agent reports while it is still working. It is progress, never authority: the hub only records it. */
export type Progress = { at?: string; step: string; detail?: string; kind?: string };

const PROGRESS_STEP = 500;
const PROGRESS_DETAIL = 4000;

export function parseProgress(input: unknown): Progress {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("进度要是一个 JSON 对象");
  }
  const given = input as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!["at", "step", "detail", "kind"].includes(name)) throw new InputError(`不认识的进度字段：${name}`);
  }
  const step = given.step;
  if (typeof step !== "string" || !step.trim() || [...step].length > PROGRESS_STEP) {
    throw new InputError(`step 要是 1 到 ${PROGRESS_STEP} 个字的文字`);
  }
  const detail = given.detail;
  if (detail !== undefined && (typeof detail !== "string" || [...detail].length > PROGRESS_DETAIL)) {
    throw new InputError(`detail 最多 ${PROGRESS_DETAIL} 个字`);
  }
  const kind = given.kind;
  if (kind !== undefined && (typeof kind !== "string" || [...kind].length > 40)) {
    throw new InputError("kind 最多 40 个字");
  }
  const at = given.at;
  if (at !== undefined && (typeof at !== "string" || !dateTime(at))) {
    throw new InputError("at 要是带时区的时间");
  }
  return {
    step: step.trim(),
    ...(detail !== undefined && { detail: detail as string }),
    ...(kind !== undefined && { kind: kind as string }),
    ...(at !== undefined && { at: at as string }),
  };
}

/** A dispatcher's placement of an unplaced event. The hub checks the project, its rule and the sender before using it. */
export type Route = {
  project: string;
  session: "continue" | "new" | "ask";
  confidence: number;
  reason?: string;
};
/** A dispatcher's request for a project that does not exist yet. The hub checks it and the host writes the configuration. */
export type Create = {
  project: string;
  description: string;
  confidence: number;
  cwd?: string;
  agent?: string;
  worker?: string;
  subjects?: string[];
};
export type Rejected = { card?: number; what?: string; reason: string };

export type EventInput = {
  id: string;
  type: string;
  subject: string;
  summary: string;
  detail: string;
  link: string;
  hops: number;
  /** Who caused it, in the source's own identity: a login name, a chat member id, or empty when the source has none. */
  actor: string;
  /** Where a reply belongs when the source names a conversation: `qq-private-<number>` or `qq-group-<number>`, never
   * free text. */
  reply?: string;
};

const LIMITS = { id: 200, subject: 100, summary: 200, detail: 4000, link: 500, actor: 200, reply: 100 } as const;
const FIELDS = ["id", "type", "subject", "summary", "detail", "link", "hops", "actor", "reply"];

export function parseEvent(input: unknown): EventInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("事件要是一个 JSON 对象");
  }
  const given = input as Record<string, unknown>;
  for (const name of Object.keys(given)) if (!FIELDS.includes(name)) throw new InputError(`不认识的字段：${name}`);
  const field = (name: keyof typeof LIMITS | "type", required = false) => {
    const value = given[name] ?? "";
    if (typeof value !== "string") throw new InputError(`${name} 要是文字`);
    if (required && !value) throw new InputError(`缺少 ${name}`);
    if (name !== "type" && [...value].length > LIMITS[name]) throw new InputError(`${name} 最多 ${LIMITS[name]} 个字`);
    return value;
  };
  const hops = given.hops === undefined ? 0 : given.hops;
  if (!Number.isSafeInteger(hops) || (hops as number) < 0) throw new InputError("hops 要是非负整数");
  const event = {
    id: field("id", true),
    type: field("type", true),
    subject: field("subject"),
    summary: field("summary"),
    detail: field("detail"),
    link: field("link"),
    hops: hops as number,
    actor: field("actor"),
    ...(given.reply !== undefined && { reply: field("reply") }),
  };
  // Half a Unicode character is stored and looked up as different bytes, so the same id would never be recognised again.
  if (!event.id.isWellFormed()) throw new InputError("id 里有不完整的字符");
  if (!EVENT_TYPE.test(event.type)) throw new InputError("type 只能用小写字母、数字和 . _ -，以字母开头");
  // The subject and link go into the Agent's prompt, so neither may carry words: a subject is an identifier, a link a
  // web address in plain ASCII (anything else percent-encoded).
  if (!/^[A-Za-z0-9#._:\/@-]*$/.test(event.subject)) throw new InputError("subject 只能用字母、数字和 # . _ : / @ -");
  if (event.link && !/^https?:\/\/[\x21-\x7e]+$/.test(event.link)) {
    throw new InputError("link 要是网址，非 ASCII 的字要先编码");
  }
  // An actor names who caused it, so it is held to the same shape as a subject: an identity, never prose.
  if (!/^[A-Za-z0-9#._:\/@-]*$/.test(event.actor)) throw new InputError("actor 只能用字母、数字和 # . _ : / @ -");
  if (event.reply !== undefined && !/^qq-(private|group)-[1-9][0-9]*$/.test(event.reply)) {
    throw new InputError("reply 只能是 qq-private-<QQ 号> 或 qq-group-<群号>");
  }
  return event;
}

type Item = Record<string, unknown>;

const text = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim() !== "" && [...value].length <= limit;
const optional = (value: unknown, limit: number) =>
  value === undefined || (typeof value === "string" && [...value].length <= limit);
const only = (item: object, names: string[]) => Object.keys(item).every((name) => names.includes(name));
const isItem = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
const items = (value: unknown, limit: number): value is Item[] =>
  value === undefined || (Array.isArray(value) && value.length <= limit && value.every(isItem));
/** A list of at most `limit` objects that each pass, or no list at all. */
const listOf = (value: unknown, limit: number, valid: (item: Item) => boolean) =>
  items(value, limit) && (value === undefined || value.every(valid));

export function dateTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysIn = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn[month - 1] && hour < 24 && minute < 60 && second < 60;
}

const validAsk = (ask: Item) =>
  only(ask, ["title", "text", "options", "recommend", "about", "key"]) &&
  text(ask.title, 200) &&
  text(ask.text, 4000) &&
  optional(ask.about, 4000) &&
  optional(ask.key, 100) &&
  Array.isArray(ask.options) &&
  ask.options.length >= 2 &&
  ask.options.length <= 5 &&
  ask.options.every((option) => text(option, 200)) &&
  (ask.recommend === undefined ||
    (Number.isInteger(ask.recommend) &&
      (ask.recommend as number) >= 0 &&
      (ask.recommend as number) < ask.options.length));

/** A question as a receipt asks it, here asked by a task elsewhere. */
export const isAsk = (value: unknown) => isItem(value) && validAsk(value as Item);

const REPORT_STATES = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];
const DECISIONS = ["accept", "stop", "ignore", "unavailable"];
const STRENGTHS = ["explicit", "inferred"];

const validReport = (report: unknown): boolean => {
  if (!isItem(report)) return false;
  const item = report as Item;
  return only(item, ["state", "note"]) && REPORT_STATES.includes(item.state as string) && optional(item.note, 500);
};

const validVerdict = (verdict: unknown): boolean => {
  if (!isItem(verdict)) return false;
  const item = verdict as Item;
  return (
    only(item, ["decision", "reason", "strength", "scope"]) &&
    DECISIONS.includes(item.decision as string) &&
    optional(item.reason, 1000) &&
    (item.strength === undefined || STRENGTHS.includes(item.strength as string)) &&
    optional(item.scope, 1000)
  );
};

const SESSIONS = ["continue", "new", "ask"];
const PROJECT_ID = /^[A-Za-z0-9._-]{1,40}$/;
const validCreate = (create: unknown): boolean => {
  if (!isItem(create)) return false;
  const item = create as Item;
  return (
    only(item, ["project", "description", "confidence", "cwd", "agent", "worker", "subjects"]) &&
    typeof item.project === "string" &&
    PROJECT_ID.test(item.project) &&
    text(item.description, 1000) &&
    typeof item.confidence === "number" &&
    Number.isFinite(item.confidence) &&
    item.confidence >= 0 &&
    item.confidence <= 1 &&
    optional(item.cwd, 300) &&
    optional(item.agent, 100) &&
    optional(item.worker, 100) &&
    (item.subjects === undefined ||
      (Array.isArray(item.subjects) &&
        item.subjects.length > 0 &&
        item.subjects.length <= 100 &&
        item.subjects.every((subject) => text(subject, 300))))
  );
};
const validRoute = (route: unknown): boolean => {
  if (!isItem(route)) return false;
  const item = route as Item;
  return (
    only(item, ["project", "session", "confidence", "reason"]) &&
    text(item.project, 100) &&
    SESSIONS.includes(item.session as string) &&
    typeof item.confidence === "number" &&
    Number.isFinite(item.confidence) &&
    item.confidence >= 0 &&
    item.confidence <= 1 &&
    optional(item.reason, 1000)
  );
};

const validNotice = (notice: Item) =>
  only(notice, ["title", "text", "key", "fyi"]) &&
  text(notice.title, 200) &&
  text(notice.text, 4000) &&
  optional(notice.key, 100) &&
  (notice.fyi === undefined || typeof notice.fyi === "boolean");

const validResolve = (item: Item) =>
  only(item, ["card", "reason"]) &&
  Number.isSafeInteger(item.card) &&
  (item.card as number) > 0 &&
  text(item.reason, 1000);

const validLater = (later: Item) =>
  only(later, ["key", "at", "about", "cancel"]) &&
  text(later.key, 100) &&
  (later.cancel === true
    ? later.at === undefined
    : dateTime(later.at) && text(later.about, 4000) && later.cancel === undefined);

const validUsage = (usage: unknown) =>
  usage === undefined ||
  (isItem(usage) &&
    Object.values(usage as Item).every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0));

export function parseResult(input: unknown): Result {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("结果要是一个 JSON 对象");
  }
  const result = { ...input } as Item;
  if (
    !only(result, [
      "outcome",
      "summary",
      "error",
      "session",
      "usage",
      "ask",
      "notice",
      "resolve",
      "later",
      "events",
      "report",
      "verdict",
      "route",
      "create",
    ])
  ) {
    throw new InputError("结果里有不认识的字段");
  }
  if (!["done", "nothing", "failed", "cancelled"].includes(result.outcome as string)) {
    throw new InputError("outcome 只能是 done、nothing、failed、cancelled");
  }
  if (!optional(result.summary, 500) || !optional(result.error, 500) || !optional(result.session, 500)) {
    throw new InputError("summary、error、session 最多 500 字");
  }
  if (!validUsage(result.usage)) throw new InputError("usage 要是对象，里面要是有限的非负数字");
  if (!listOf(result.ask, 5, validAsk)) {
    throw new InputError("ask 每一项要有 title、text 和 2 到 5 个 options，recommend 是其中一个的序号，最多 5 项");
  }
  if (!listOf(result.notice, 10, validNotice)) throw new InputError("notice 每一项要有 title 和 text，最多 10 项");
  if (!listOf(result.resolve, 50, validResolve)) {
    throw new InputError("resolve 每一项要有卡片编号和 1000 字以内的核实依据，最多 50 项");
  }
  if (!listOf(result.later, 10, validLater)) {
    throw new InputError("later 每一项要有 key，以及带时区的 at 和 about，或者 cancel: true，最多 10 项");
  }
  if (result.report !== undefined && !validReport(result.report)) {
    throw new InputError(`report 要有 state（${REPORT_STATES.join("、")}），note 最多 500 字`);
  }
  if (result.verdict !== undefined && !validVerdict(result.verdict)) {
    throw new InputError(`verdict 要有 decision（${DECISIONS.join("、")}），reason、scope 最多 1000 字`);
  }
  if (result.route !== undefined && !validRoute(result.route)) {
    throw new InputError(
      "route 要有 project、session（continue、new、ask）、0 到 1 的 confidence，reason 最多 1000 字",
    );
  }
  if (result.create !== undefined && !validCreate(result.create)) {
    throw new InputError(
      "create 要有 project（字母、数字和 . _ -）、description 和 0 到 1 的 confidence，cwd、agent、worker、subjects 可选且不与其他字段混用",
    );
  }
  if (result.events !== undefined) {
    if (!items(result.events, 100)) throw new InputError("events 最多 100 项");
    result.events = result.events.map(parseEvent);
  }
  return result as Result;
}
