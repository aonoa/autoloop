// A QQ message bridge: one person's task, private or in a group, becomes a `qq.task` event. It is deliberately not a
// channel: a task is work, while a card answer only answers work already queued. The bridge only translates and posts;
// the source key says which hub door it uses.
//   rules.json:  "sources": { "qq": { "name": "QQ", "policy": { "allowlist": ["10001"] } } }
//   config.json: "channels": { "qq": { "use": "qq-source", "key": "…", "url": "http://127.0.0.1:3350",
//                                   "sourceKey": "…", "allowed": ["10001"], "groups": ["20002"],
//                                   "bot": "30003003" } }
// The source key belongs to the source, not the channel. A QQ number that isn't on `allowed` is ignored before any task is
// made; the source policy checks it again. A group message is a task when the group is on `groups` and the sender is on
// `allowed`, and its answer goes back to that group.
// A message may start with a topic: `/shop fix the checkout` makes the task's subject `qq-group-<group>/shop`, so rules
// with `parallel` keep each topic on its own lane (and, with `resume`, on its own session). The prefix is removed from the
// task's words; `reply` still points at the whole conversation.

export type Options = {
  allowed?: string[];
  groups?: string[];
  bot?: string;
  url?: string;
  sourceKey?: string;
};

export type Task = {
  id: string;
  type: string;
  subject: string;
  summary: string;
  detail: string;
  actor: string;
  link: string;
  reply: string;
};

type Event = {
  post_type?: string;
  message_type?: string;
  self_id?: string | number;
  user_id?: string | number;
  group_id?: string | number;
  message_id?: string | number;
  raw_message?: string;
  message?: unknown;
};

/** The words a person sent and the message they quoted, from either OneBot message format. */
export function wordsOf(message: unknown, raw = "") {
  let text = typeof message === "string" ? message : "";
  let reply = "";
  if (Array.isArray(message)) {
    text = message
      .flatMap((segment) =>
        segment?.type === "text" && typeof segment.data?.text === "string" ? [segment.data.text] : [],
      )
      .join("");
    const quoted = message.find((segment) => segment?.type === "reply");
    if (quoted?.data?.id !== undefined) reply = String(quoted.data.id);
  }
  text = text || raw;
  // A string message may carry an @ or reply as a CQ code; neither is part of the task.
  text = text.replace(/\[CQ:[^\]]*\]/g, "");
  const cqReply = /\[CQ:reply,id=([^\]]+)\]/.exec(raw);
  if (!reply && cqReply) reply = cqReply[1];
  return { text, reply };
}

/** Whether a bare `#N` is a card answer, not a task. The NapCat channel owns that conversation. */
export function isCardAnswer(text: string) {
  return /^\s*#\s*[1-9][0-9]*\s*$/.test(text);
}

/** A leading `/topic ` names the thread this message belongs to; the rest is the task. */
export function topicOf(text: string) {
  const match = /^\s*\/([A-Za-z0-9._-]{1,40})\s+(.+)$/s.exec(text);
  return match ? { topic: match[1], text: match[2] } : { topic: "", text };
}

/** One OneBot message as one task, or null when it isn't a task this source accepts. */
export function taskOf(event: Event, options: Options): Task | null {
  if (event.post_type !== "message") return null;
  const group = event.message_type === "group";
  if (event.message_type !== (group ? "group" : "private")) return null;
  const sender = String(event.user_id ?? "");
  const bot = String(options.bot ?? event.self_id ?? "");
  if (!sender || sender === bot || sender === String(event.self_id ?? "")) return null;
  const allowed = options.allowed ?? [];
  if (!allowed.includes(sender)) return null;
  const conversation = group ? String(event.group_id ?? "") : sender;
  if (!conversation) return null;
  if (group && !(options.groups ?? []).includes(conversation)) return null;
  const { text, reply } = wordsOf(event.message, String(event.raw_message ?? ""));
  // A quoted reply with no words is a card interaction or a gesture, not a task. A bare number is a card answer too.
  if (!text.trim() || (reply && !text.trim()) || isCardAnswer(text)) return null;
  const { topic, text: words } = topicOf(text);
  if (!words.trim()) return null;
  const detail = words.slice(0, 4000);
  const where = group ? `qq-group-${conversation}` : `qq-private-${conversation}`;
  return {
    id: `qq:${String(event.message_id ?? "")}`,
    type: "qq.task",
    subject: topic ? `${where}/${topic}` : where,
    summary: detail.slice(0, 200),
    detail,
    actor: sender,
    link: "",
    reply: where,
  };
}

/** A stable id for an event, so a reconnect or a repeated poll cannot make the same task twice. */
export function eventKey(event: Event) {
  return String(event.message_id ?? "");
}

export function createBridge({
  url,
  key,
  options,
  log = () => {},
  signal,
  fetch = globalThis.fetch,
}: {
  url: string;
  key: string;
  options: Options;
  log?: (line: string) => void;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}) {
  const seen = new Set<string>();
  async function accept(event: Event) {
    const task = taskOf(event, options);
    if (!task) return false;
    const id = eventKey(event);
    if (seen.has(id)) return false;
    seen.add(id);
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/v1/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(task),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`中台返回 ${response.status}${body?.error ? `：${body.error}` : ""}`);
      log(`任务 ${task.id}：${body?.duplicate ? "已经收过" : `交给 ${body?.routed?.join("、") || "没有规则"}`}`);
      return true;
    } catch (error) {
      // Keep the id so a retry doesn't make a second task, but say so: a dropped task must not look like a quiet one.
      log(`任务 ${task.id} 没交上：${error}`);
      return false;
    }
  }
  return { accept, seen };
}
