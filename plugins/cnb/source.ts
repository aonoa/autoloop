// CNB has no repository webhook, so its pipelines forward the events they already run on. A build posts the event body
// here, signed with HMAC-SHA256 in x-cnb-signature-256, and it becomes the same event GitHub's webhook makes:
// `issues.opened`, `issue_comment.created`, `pull_request.closed` and so on, with `owner/repo#number` as the subject.
// For repositories with no pipeline, plugins/cnb/poll.ts reads the repository stream on a schedule instead.
//
//   rules.json:  "sources": { "cnb": { "name": "CNB", "adapter": "cnb" } }
//   secrets.env: AGENT_AUTOLOOP_SECRET_CNB=…
//   address:     /v1/in/cnb
import { createHmac, timingSafeEqual } from "node:crypto";
import { pipelineEvent, translate, type CnbEvent } from "./core.ts";

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };
type Row = Record<string, any>;

const header = (headers: Input["headers"], name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** A body of one event, an array of them, `{ events: [...] }` as plugins/cnb/push.ts sends, or one a line. */
function parse(body: string): Row[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    // A pipeline's own envelope: unwrap it, or the envelope itself would be read as an event with no repository.
    if (parsed && Array.isArray(parsed.events)) return parsed.events;
    return [parsed];
  } catch {
    const out: Row[] = [];
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed);
    }
    return out;
  }
}

/** A pipeline's own fields, as plugins/cnb/push.ts sends them. */
function fromBuild(row: Row): CnbEvent | null {
  if (typeof row.repo !== "string" || (typeof row.event !== "string" && !row.issue && !row.pullRequest)) return null;
  return pipelineEvent({
    repo: row.repo,
    event: String(row.event ?? ""),
    id: row.id === undefined ? "" : String(row.id),
    actor: row.actor === undefined ? "" : String(row.actor),
    url: row.url === undefined ? "" : String(row.url),
    title: row.title === undefined ? "" : String(row.title),
    body: row.body === undefined ? "" : String(row.body),
    issue: row.issue,
    pullRequest: row.pullRequest,
  });
}

export default function cnb({ headers, body, secret }: Input) {
  const sign = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const given = String(header(headers, "x-cnb-signature-256") ?? "");
  const signed =
    Boolean(secret) && given.length === sign.length && timingSafeEqual(Buffer.from(given), Buffer.from(sign));
  if (!signed) throw new Error("signature");
  const events: CnbEvent[] = [];
  for (const row of parse(body)) {
    const event = fromBuild(row) ?? translate(row);
    if (event) events.push(event);
  }
  return events;
}
