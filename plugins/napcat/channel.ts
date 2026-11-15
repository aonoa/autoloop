// QQ through NapCat's OneBot 11 API: HTTP sends messages and a forward WebSocket receives the replies, so no public
// address is needed. This is separate from the official QQ bot channel: it signs in as a QQ account rather than an app.
//   "channels": { "napcat": { "key": "…", "url": "http://127.0.0.1:3000",
//                             "ws": "ws://127.0.0.1:3000", "user": "123456" } } in config.json
//   "channels": { "napcat": { "name": "QQ（NapCat）", "answerers": ["123456"] } } in rules.json: who may answer.
// `user` is the fallback for cards with no source conversation (tasks from elsewhere, the hub's own alerts). A card that
// came from a QQ chat goes back to that chat instead: a private message to that person, a group message to that group.
// Whoever may answer a group card is `answerers`; a private card is answered only by the person it reached.
import type { Card, ChannelContext } from "../../host/channels.ts";

type Target = { kind: "user" | "group"; id: string };

/** A card's source conversation, when the source named one this channel can reach. */
function replyTargetOf(card: Card): Target | null {
  const match = /^qq-(private|group)-([1-9][0-9]*)$/.exec(card.reply ?? "");
  return match ? { kind: match[1] === "group" ? "group" : "user", id: match[2] } : null;
}

/** The one person or group this channel reaches: sending to both would put the same card in two places. */
function targetOf(options: Record<string, unknown>): Target {
  const user = typeof options.user === "string" ? options.user.trim() : "";
  const group = typeof options.group === "string" ? options.group.trim() : "";
  if (Boolean(user) === Boolean(group)) throw new Error("NapCat 通道要在 config.json 写 user 或 group（只能写一个）");
  const id = user || group;
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error("NapCat 的 user/group 要填 QQ 号或群号");
  return user ? { kind: "user", id } : { kind: "group", id };
}

/** One card, as it looks now: numbered choices while open, what became of it after. */
export function words(card: Card) {
  const rule = card.rule && card.rule !== card.title ? card.rule : "";
  // A chat that carries several matters needs to say which one is asking; the source and number aren't for the reader.
  const project = card.lane?.includes("/") ? (card.lane.split("/").at(-1)?.trim() ?? "") : "";
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  const outcome =
    card.state === "decided"
      ? `你选了「${chosen}」，已记录，等待处理。`
      : card.state === "done"
        ? `你选了「${chosen}」。${card.result ? `已执行：${card.result}` : "已执行。"}`
        : card.state === "closed" && card.kind === "ask"
          ? `不用决定了：${card.result ?? ""}`
          : card.state === "closed" && card.result
            ? card.result
            : "";
  const note = card.kind === "notice" && card.answer ? `处理说明：${card.answer}` : "";
  const choices =
    card.state === "open"
      ? card.options
          .map((option, index) => `#${index + 1}. ${option}`)
          .concat(card.options.length ? ["直接回复 #1、#2……选择其中一项。"] : [])
      : [];
  return [
    card.title,
    rule ? `来源：${rule}` : "",
    project ? `项目：${project}` : "",
    card.text,
    outcome,
    note,
    ...choices,
    card.link ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The choice a reply asks for, counting from zero; anything besides a bare `#number` is not an answer. */
export function choiceOf(text: string) {
  const match = /^\s*#\s*([1-9][0-9]*)\s*$/.exec(text);
  return match ? Number(match[1]) - 1 : null;
}

/** The words a person sent and the message they quoted, from either OneBot message format. */
export function messageOf(message: unknown, raw = "") {
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
  // A string message may carry an @ or reply as a CQ code; neither is part of the answer.
  text = text.replace(/\[CQ:[^\]]*\]/g, "");
  const cqReply = /\[CQ:reply,id=([^\]]+)\]/.exec(raw);
  if (!reply && cqReply) reply = cqReply[1];
  return { text, reply };
}

type Reply = { text: string; reply: string; user: string; group: string; message: string };

/** The reply that can answer this channel, or null for every other message, including another group's. */
export function replyOf(
  event: any,
  target: Target,
  extraUsers: Set<string> = new Set(),
  extraGroups: Set<string> = new Set(),
): Reply | null {
  if (event?.post_type !== "message" || String(event.self_id ?? "") === String(event.user_id ?? "")) return null;
  const group = event.message_type === "group";
  if (event.message_type !== (group ? "group" : "private")) return null;
  const { text, reply } = messageOf(event.message, String(event.raw_message ?? ""));
  const user = String(event.user_id ?? "");
  const room = String(event.group_id ?? "");
  const message = String(event.message_id ?? "");
  if (group) {
    // The configured group and any group a card was actually sent to; another group's `#1` is not this channel's.
    if (target.kind === "group" ? room !== target.id && !extraGroups.has(room) : !extraGroups.has(room)) return null;
    return { text, reply, user, group: room, message };
  }
  // A private target accepts its own person, anyone a card was actually sent to, and anyone else, so a mistaken `#1`
  // can be told why it did nothing instead of vanishing. A group only reads its own members' words.
  if (target.kind === "group" && !extraUsers.has(user)) return null;
  return { text, reply, user, group: "", message };
}

export default async function napcat({ hub, options, log, signal }: ChannelContext) {
  const target = targetOf(options);
  const api = (typeof options.url === "string" ? options.url : "").replace(/\/$/, "");
  const ws = typeof options.ws === "string" ? options.ws : "";
  const token = typeof options.token === "string" ? options.token : "";
  if (!api) throw new Error("NapCat 通道要在 config.json 写 url（OneBot HTTP 地址）");
  if (!ws) throw new Error("NapCat 通道要在 config.json 写 ws（OneBot 正向 WebSocket 地址）");

  async function call(action: string, params: Record<string, unknown>) {
    const response = await fetch(`${api}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`NapCat ${action} 返回 ${response.status}`);
    if (body?.status !== "ok" || Number(body?.retcode) !== 0) {
      throw new Error(`NapCat ${action} 失败：${JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data;
  }

  const id = (value: string) => (/^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value);
  async function sendText(text: string, to: Target = target) {
    return call(to.kind === "group" ? "send_group_msg" : "send_private_msg", {
      ...(to.kind === "group" ? { group_id: id(to.id) } : { user_id: id(to.id) }),
      message: [{ type: "text", data: { text } }],
    });
  }

  // The answers a person can give are on messages this process sent. Keep the newest message per card and the cards that
  // are still waiting, so a bare `#1` is only accepted when there is no doubt which card it belongs to.
  const sentBefore = new Set<number>();
  const open = new Map<number, string>();
  const cardsByMessage = new Map<string, number>();
  // Which QQ a card went to: an answer must come from that same person, not merely quote a message id.
  const owners = new Map<number, string>();
  // A group card's conversation: a numbered reply there belongs to this chat, not to whichever private chat also has one.
  const conversations = new Map<number, string>();
  function forget(card: number) {
    const message = open.get(card);
    if (message) cardsByMessage.delete(message);
    open.delete(card);
    owners.delete(card);
    conversations.delete(card);
  }

  const where = (target: Target) => `${target.kind === "group" ? "group" : "private"}-${target.id}`;

  async function send(card: Card) {
    const to = replyTargetOf(card) ?? target;
    const sent = await sendText(words(card), to);
    const message = String(sent?.message_id ?? "");
    if (!message) throw new Error(`NapCat 没有确认消息发出：${JSON.stringify(sent).slice(0, 300)}`);
    sentBefore.add(card.id);
    if (card.state === "open") {
      open.set(card.id, message);
      cardsByMessage.set(message, card.id);
      conversations.set(card.id, where(to));
      if (to.kind === "user") owners.set(card.id, to.id);
    }
    return `napcat-card-${card.id}`;
  }

  /** The card a bare number in this conversation means: one waiting card, and only one, in that chat. A quoted message
   * may name a card sent elsewhere: answering it is still refused, with a word to the person who tried. */
  function cardIn(reply: Reply) {
    if (reply.reply) return cardsByMessage.get(reply.reply);
    const here = where(reply.group ? { kind: "group", id: reply.group } : { kind: "user", id: reply.user });
    const waiting = [...open.keys()].filter((card) => (conversations.get(card) ?? "") === here);
    // One card is waiting anywhere: a bare number means it, and the checks below say whether this person may answer it.
    return waiting.length === 1 ? waiting[0] : open.size === 1 ? open.keys().next().value : undefined;
  }

  async function answer(reply: Reply) {
    const choice = choiceOf(reply.text);
    if (choice === null) return;
    const card = cardIn(reply);
    const here = where(reply.group ? { kind: "group", id: reply.group } : { kind: "user", id: reply.user });
    const elsewhere = card !== undefined && conversations.has(card) && conversations.get(card) !== here;
    if (card !== undefined && (elsewhere || (owners.has(card) && owners.get(card) !== reply.user))) {
      await sendText("这张卡片不是发给你的，不能由你回答。", { kind: "user", id: reply.user }).catch((error) =>
        log(`NapCat 没法提示怎么回答：${error}`),
      );
      return;
    }
    if (card === undefined) {
      // A bare number can't choose between cards, and silence would make the person think it worked.
      await sendText(
        reply.reply
          ? "这条消息不是本通道发出的卡片，请引用卡片消息再回复。"
          : "有几张卡片在等回答，请引用要回答的那条消息，再回复 #1、#2……",
        reply.group ? { kind: "group", id: reply.group } : { kind: "user", id: reply.user },
      ).catch((error) => log(`NapCat 没法提示怎么回答：${error}`));
      return;
    }
    // The hub knows which channel this key belongs to, so it checks that channel's answerers.
    const result = await hub.answer(card, { choice, by: reply.user, ref: `napcat-card-${card}` });
    forget(card);
    log(`卡片 ${card}：${reply.user} 回复 ${reply.text.trim()}，${result?.changed ? "已记录" : "已经结束"}`);
  }

  let handling = Promise.resolve();
  function listen() {
    return new Promise<void>((resolve) => {
      const url = new URL(ws);
      if (token) url.searchParams.set("access_token", token);
      const socket = new WebSocket(url);
      let closed = false;
      const stop = () => {
        if (!closed) socket.close();
      };
      signal.addEventListener("abort", stop, { once: true });
      socket.addEventListener("message", (event) => {
        let payload: any;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          log("NapCat 发来一段读不懂的数据");
          return;
        }
        const groups = new Set(
          [...conversations.values()].filter((value) => value.startsWith("group-")).map((value) => value.slice(6)),
        );
        const reply = replyOf(payload, target, new Set(owners.values()), groups);
        if (reply) handling = handling.then(() => answer(reply)).catch((error) => log(`NapCat 回答没处理：${error}`));
      });
      // A stop may reset the socket on its way out. There is nothing left to reconnect then, and this must not become an
      // uncaught error in the hub's process.
      socket.addEventListener("error", (event) => {
        if (!signal.aborted) log(`NapCat WebSocket：${(event as any)?.message ?? "连接出错"}`);
      });
      socket.addEventListener("close", () => {
        closed = true;
        signal.removeEventListener("abort", stop);
        resolve();
      });
    });
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`连不上中台：${error}`);
        await pause(10_000, signal);
        continue;
      }
      if (!card) continue;
      // NapCat has no message edit call. An accepted message stays as it was; report the same ref instead of sending a
      // second card with the same choices.
      if (card.ref) {
        if (card.state !== "open") forget(card.id);
        await hub.delivered(card.id, card.version, card.ref);
        sentBefore.delete(card.id);
        continue;
      }
      // Sending succeeded but the report to the hub was lost: the message is already there, so report it again rather
      // than putting a second copy of the same card in the chat.
      const already = sentBefore.has(card.id);
      if (already) {
        await hub.delivered(card.id, card.version, `napcat-card-${card.id}`);
        sentBefore.delete(card.id);
        continue;
      }
      try {
        const ref = await send(card);
        await hub.delivered(card.id, card.version, ref);
        sentBefore.delete(card.id);
      } catch (error) {
        log(`卡片 ${card.id} 没发出：${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  const sending = deliver();
  while (!signal.aborted) {
    await listen();
    if (!signal.aborted) {
      log("NapCat WebSocket 断开了，5 秒后重连");
      await pause(5_000, signal);
    }
  }
  await sending;
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
