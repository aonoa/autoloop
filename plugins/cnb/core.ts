// CNB's events as the hub knows them. The repository stream and a pipeline's CNB_* variables both become the same small
// event GitHub's webhook makes, so a rule names a repository and a number the same way whichever side found it.
//
// The stream is one JSON object per line. The id is a 64-bit integer that JSON.parse rounds, so the id is cut out of the
// raw line as text first: two events one apart would otherwise share a dedupe key and the second would never arrive.

export type CnbEvent = {
  id: string;
  type: string;
  subject: string;
  summary: string;
  detail: string;
  link: string;
  actor: string;
};

type Row = Record<string, any>;

const KINDS: Record<string, string> = {
  IssueEvent: "issues",
  IssueCommentEvent: "issue_comment",
  PullRequestEvent: "pull_request",
  PullRequestReviewEvent: "pull_request_review",
  PullRequestReviewCommentEvent: "pull_request_review_comment",
  PushEvent: "push",
  ReleaseEvent: "release",
  CreateEvent: "create",
  DeleteEvent: "delete",
  ForkEvent: "fork",
  MemberEvent: "member",
  PublicEvent: "public",
  WatchEvent: "watch",
};

const lower = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-");
const text = (value: unknown) =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

/** A login, as a policy may name it: an identity, never words. */
const actor = (value: unknown) => {
  const given = text(value);
  return /^[A-Za-z0-9#._:/@-]*$/.test(given) ? given.slice(0, 200) : "";
};

const number = (value: unknown) => {
  const given = text(value).replace(/^#/, "");
  return /^[0-9]+$/.test(given) ? `#${given}` : "";
};
const repoOf = (row: Row) => text(row.repo?.full_name ?? row.repo?.name ?? row.repository?.full_name);
const subjectOf = (repo: string, value: string) => `${repo}${value}`.replace(/[^A-Za-z0-9#._:/@-]/g, "-").slice(0, 100);
const linkOf = (value: unknown) => {
  const given = text(value);
  return given ? encodeURI(given).slice(0, 500) : "";
};

/** The id as the platform wrote it, so JSON rounding can't merge two events; without one, the line itself. */
export function eventId(line: string) {
  const found = /"id"\s*:\s*"?([0-9]+)"?/.exec(line);
  if (found) return found[1];
  return `sha-${hash(line)}`;
}

function hash(line: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** What a rule calls it: CNB's type and action, in GitHub's words where the two platforms mean the same thing. */
export function typeOf(row: Row) {
  const kind = String(row.type ?? "");
  const name = KINDS[kind] ?? lower(kind);
  const action = lower(row.action ?? row.payload?.action ?? row.object_attributes?.action);
  // CNB reports a merge as its own action; GitHub reports it as a closed pull request carrying a merge time.
  if (name === "pull_request" && action === "merged") return "pull_request.closed";
  // The stream says a comment was `opened`; GitHub, whose words the rules are written in, says `created`.
  const said = name.endsWith("comment") && action === "opened" ? "created" : action;
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) return "";
  return said ? `${name}.${said}` : name;
}

/** One event of the stream. A line with nothing a rule could act on is not an event, not an error. */
export function translate(row: Row, id = ""): CnbEvent | null {
  const type = typeOf(row);
  if (!type) return null;
  const payload = row.payload ?? row;
  const object = payload.pull_request ?? payload.issue ?? payload.release ?? payload;
  const comment = payload.comment;
  const repo = repoOf(row);
  const isPush = type.startsWith("push");
  const commit = isPush ? payload.commits?.[0] : undefined;
  const summary = text(comment?.body ?? object?.title ?? payload.release?.name ?? commit?.message);
  const detail = text(comment?.body ?? object?.body ?? payload.release?.body ?? (isPush ? commit?.message : ""));
  const link =
    linkOf(comment?.html_url ?? object?.html_url ?? payload.release?.html_url) ||
    linkOf(isPush && payload.head ? `https://cnb.cool/${repo}/-/commit/${payload.head}` : "") ||
    linkOf(repo ? `https://cnb.cool/${repo}` : "");
  return {
    id: id || eventId(JSON.stringify(row)),
    type,
    subject: subjectOf(repo, isPush ? "" : number(object?.number ?? payload.number)),
    summary: summary.slice(0, 200),
    detail: detail.slice(0, 4000),
    link,
    actor: actor(row.actor?.username ?? object?.user?.username ?? comment?.user?.username),
  };
}

/** A build's CNB_* variables: one event worth forwarding, and the link where a person can read the rest. */
export type PipelineInput = {
  repo?: string;
  event: string;
  id?: string;
  actor?: string;
  url?: string;
  title?: string;
  body?: string;
  issue?: { number?: string | number; title?: string; body?: string; html_url?: string };
  pullRequest?: { number?: string | number; title?: string; body?: string; html_url?: string };
};

export function pipelineEvent(input: PipelineInput): CnbEvent | null {
  const repo = text(input.repo);
  if (!repo) return null;
  const raw = lower(input.event);
  const alias: Record<string, string> = {
    "issue.open": "issues.opened",
    "issue.opened": "issues.opened",
    "issue.close": "issues.closed",
    "issue.closed": "issues.closed",
    "issue.reopen": "issues.reopened",
    "issue.reopened": "issues.reopened",
    "issue.comment": "issue_comment.created",
    "issue.update": "issues.edited",
    "issue.update.assignee_change": "issues.assigned",
    "issue.update.label_change": "issues.labeled",
    "issue.update.priority_change": "issues.edited",
    "pull_request.merged": "pull_request.closed",
    "pull_request.update": "pull_request.edited",
    // A PR's comments and its review comments share one pipeline event. Code comments also arrive as this stream event,
    // so this is the closer of the two GitHub names; plugins/cnb/push.ts picks by CNB_COMMENT_TYPE when it can.
    "pull_request.comment": "pull_request_review_comment.created",
    pull_request: "pull_request.opened",
  };
  const type = alias[raw] ?? raw;
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(type)) return null;
  const target = input.pullRequest ?? input.issue ?? null;
  return {
    id: text(input.id) || `pipeline-${repo}-${type}-${text(input.url)}`,
    type,
    subject: subjectOf(repo, target ? number(target.number) : ""),
    summary: text(target?.title ?? input.title).slice(0, 200),
    detail: text(target?.body ?? input.body).slice(0, 4000),
    link: linkOf(target?.html_url ?? input.url) || `https://cnb.cool/${repo}`,
    actor: actor(input.actor),
  };
}

/** The stream: one object a line, or the array the docs show. Each is paired with the id as the platform wrote it. */
function entries(input: string): { rows: Row[]; ids: string[]; broken: boolean } {
  const trimmed = input.trim();
  const rowsOut: Row[] = [];
  const ids: string[] = [];
  let broken = false;
  if (!trimmed) return { rows: rowsOut, ids, broken };
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      parsed.forEach((row, index) => {
        if (!row || typeof row !== "object") return;
        rowsOut.push(row);
        // An array of objects has the rounded number JSON.parse already made of each id, and the line's own text is gone.
        // Position keeps two neighbouring events apart; merging them would silently drop one, which is worse than a
        // repeat the hub would drop anyway.
        ids.push(`${eventId(JSON.stringify(row))}-${index}`);
      });
      return { rows: rowsOut, ids, broken };
    }
    if (parsed && typeof parsed === "object") return { rows: [parsed], ids: [eventId(trimmed)], broken };
  } catch {
    // The API gives NDJSON; the docs show an array. Only the line-by-line path keeps a 64-bit id whole.
  }
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) {
        rowsOut.push(row);
        ids.push(eventId(line));
      } else broken = true;
    } catch {
      broken = true;
    }
  }
  return { rows: rowsOut, ids, broken };
}

/** The rows of a page, for a caller that wants the platform's objects rather than the hub's events. */
export function rows(input: string) {
  const read = entries(input);
  return { rows: read.rows, broken: read.broken };
}

/** Every event in one page, each with the id the platform gave it, counted once. */
export function eventsOf(input: string) {
  const read = entries(input);
  const seen = new Set<string>();
  const events: CnbEvent[] = [];
  read.rows.forEach((row, index) => {
    const id = read.ids[index];
    if (seen.has(id)) return;
    const event = translate(row, id);
    if (!event) return;
    seen.add(id);
    events.push(event);
  });
  return { events, broken: read.broken };
}
