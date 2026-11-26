// What the kernel reads in rules: their shape and which events a rule takes. The rules file is checked before it gets
// here, in protocol/rules.ts.
export type Access = "read" | "edit" | "full";
/** Who may originate work through a source, and on what terms. Absent means the source's own key is the only authority. */
export type SourcePolicy = {
  /** Identities, in the source's own words, that may originate work. Empty means anyone the source admits. */
  allowlist?: string[];
  /** `named` requires the event to address the agent; `any` takes any event the source sends. */
  admission?: "named" | "any";
  /** Bots allowed to make candidates; other bots' events are recorded and not dispatched. */
  bots?: string[];
};
export type Source = { name: string; adapter?: string; policy?: SourcePolicy };
/**
 * How work is accepted: `off` is today's behaviour; `gate` adds the deterministic authorization check; `assess` also asks a
 * model, through an ordinary round of the assessor Agent, before a rule takes an event.
 */
export type Accept = "off" | "gate" | "assess";
export type Policy = {
  accept: Accept;
  assessor?: string;
  /** Whether an event also reaches the live matters of other rules on the same subject, as context only. Off by default. */
  fanout?: boolean;
};
type AgentOptions = {
  model?: string;
  effort?: string;
  tier?: string;
  command?: string[];
  program?: string;
  timeout?: number;
};
export type Agent = AgentOptions & { name: string; worker: string; use: string; access: Access; maxActive?: number };
/**
 * What kind of place a channel is, which decides how its messages read: `im` for a chat where a long reply is noise,
 * `async` for a review or an issue where a full write-up is the point. Absent means no rule is given.
 */
export type ChannelStyle = "im" | "async";
export type Channel = { name: string; answerers?: string[]; links?: boolean; style?: ChannelStyle };
export type Tell = "always" | "needed" | "never";
type EventFilter = {
  source: string;
  types: string[];
  /** Optional lane prefixes. A rule that names them only takes events whose subject matches one; absent means any. */
  subjects?: string[];
};
type When = EventFilter | { cron: string };
type RuleWords = { skill?: string; prompt?: string };
/** A session's name for clients that take it from the first line: {subject} and {id} filled in by the worker. */
type RuleOptions = RuleWords & {
  title?: string;
  parallel?: number;
  maxActive?: number;
  resume?: boolean;
  emits?: EventFilter;
  /** Run a round in the background first and only hand it to a person when it found something worth delivering. */
  speculate?: boolean;
};
/** Without channels a rule's cards reach the default ones, or every channel if there are none; with them, only those. */
type Reach = { channels?: string[] };
/** Without parallel a rule's group runs one at a time; with it, each subject is its own thread, that many at once. */
export type Rule = RuleOptions &
  Reach & {
    name: string;
    when: When;
    to: string;
    cwd: string;
    group: string;
    tell: Tell;
    /** The project this rule belongs to. It is a naming and grouping shorthand, not a runtime concept: `cwd` and `group`
     * still decide where work runs and how many run at once. */
    project?: string;
  };
/** A scheduled task that runs elsewhere (say, in the Claude app): the hub neither starts nor records it. With a cwd it can
 * also ask, and your answer goes on there like a round of a rule. */
export type Elsewhere = RuleWords & {
  name: string;
  source: string;
  to: string;
  cron: string;
  where: string;
  /** What its app runs it on, only to be shown: the hub starts nothing with them. */
  model?: string;
  effort?: string;
  cwd?: string;
};
type Registered = { sources: Record<string, Source>; agents: Record<string, Agent>; channels: Record<string, Channel> };
export type Rules = Registered & {
  timezone: string;
  askFirst: string[];
  policy?: Policy;
  /** Where a card that names no channels of its own goes: a tell, the hub's own alerts, a rule without a list. */
  defaultChannels?: string[];
  rules: Rule[];
  elsewhere: Elsewhere[];
};

/** The source of what the clock makes happen. */
export const SCHEDULE = "schedule";

function typeMatch(pattern: string, type: string) {
  return pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
}
export const typeMatches = (patterns: string[], type: string) => patterns.some((pattern) => typeMatch(pattern, type));
/** A subject pattern is an exact lane, or a prefix ending in `*`; `/qq-group-1/shop*` covers a lane's answers too. */
function subjectMatch(pattern: string, subject: string) {
  return pattern.endsWith("*") ? subject.startsWith(pattern.slice(0, -1)) : subject === pattern;
}
export const subjectMatches = (patterns: string[] | undefined, subject: string) =>
  !patterns?.length || patterns.some((pattern) => subjectMatch(pattern, subject));
export const eventRule = (rule: Rule): rule is Rule & { when: EventFilter } => "source" in rule.when;
export const cronOf = (rule: Rule) => (rule.when as { cron: string }).cron;

/** The rule a run, card or timer names: a rule's own, or a task elsewhere's, which only your answers to it start. */
export function ruleOf(rules: Rules, name: string): Rule | undefined {
  const rule = rules.rules.find((rule) => rule.name === name);
  if (rule) return rule;
  const task = rules.elsewhere.find((task) => task.name === name);
  if (!task?.cwd) return undefined;
  const { source, to, cwd, skill, prompt } = task;
  // No event type matches none: nothing that comes in starts it.
  return { name, when: { source, types: [] }, to, cwd, skill, prompt, group: name, tell: "needed" };
}

/** What a deterministic gate says about one event and one rule: whether it may start work, and on what basis. */
export type Admission =
  { state: "accept"; strength: "explicit" | "inferred"; reason: string } | { state: "ignore"; reason: string };

const words = (value: string) => value.toLowerCase();
/** A name must stand on its own: ASCII ids inside prose (`a` in `said`) are not mentions. */
const namedIn = (said: string, name: string) => {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "i").test(said);
};
/** Whether a person's message addresses the agent: its name, or `@name`, in the subject or the summary. */
function names(agent: string, event: { subject: string; summary: string }) {
  if (!agent) return false;
  const said = `${event.subject}\n${event.summary}`;
  return namedIn(words(said), words(agent)) || said.includes(`@${agent}`);
}

/**
 * The gate: who may originate work through a source, and how strong that basis is. With no policy the source's own key is
 * the only authority, which is today's behaviour; a policy narrows it and nothing else.
 */
export function admit(
  policy: Policy | undefined,
  source: SourcePolicy | undefined,
  agent: { id: string; name: string },
  event: { subject: string; summary: string; actor: string },
): Admission {
  if (!policy || (policy.accept ?? "off") === "off" || !source)
    return { state: "accept", strength: "explicit", reason: "source_key" };
  const actor = event.actor;
  if (!actor) return { state: "ignore", reason: "no_actor" };
  const bot = !!source.bots?.includes(actor);
  const listed = !!source.allowlist?.includes(actor);
  // An empty list is how a source says "anyone the source itself admits", not "nobody".
  if (!bot && source.allowlist?.length && !listed) return { state: "ignore", reason: "not_allowed" };
  if (!bot && source.admission === "named" && !names(agent.id, event) && !names(agent.name, event)) {
    return { state: "ignore", reason: "not_named" };
  }
  return {
    state: "accept",
    strength: listed || bot ? "explicit" : "inferred",
    reason: listed ? "allowed" : bot ? "bot" : "source_key",
  };
}
