// QQ through NapCat's OneBot 11 API: HTTP sends messages and a forward WebSocket receives the replies, so no public
// address is needed. This is separate from the official QQ bot channel: it signs in as a QQ account rather than an app.
//   "channels": { "napcat": { "key": "…", "url": "http://127.0.0.1:3000",
//                             "ws": "ws://127.0.0.1:3000", "user": "123456" } } in config.json
//   "channels": { "napcat": { "name": "QQ（NapCat）", "answerers": ["123456"] } } in rules.json: who may answer.
// Use "group": "GROUP_NUMBER" instead of "user" to send to a group; a card reaches exactly one of them.
import type { Card, ChannelContext } from "../../host/channels.ts";

type Target = { kind: "user" | "group"; id: string };

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
  return [card.title, rule ? `来源：${rule}` : "", card.text, outcome, note, ...choices, card.link ?? ""]
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
export function replyOf(event: any, target: Target): Reply | null {
  if (event?.post_type !== "message" || String(event.self_id ?? "") === String(event.user_id ?? "")) return null;
  if (target.kind === "group" ? event.message_type !== "group" : event.message_type !== "private") return null;
  if (target.kind === "group" && String(event.group_id ?? "") !== target.id) return null;
  if (target.kind === "user" && String(event.user_id ?? "") !== target.id) return null;
  const { text, reply } = messageOf(event.message, String(event.raw_message ?? ""));
  return {
    text,
    reply,
    user: String(event.user_id ?? ""),
    group: String(event.group_id ?? ""),
    message: String(event.message_id ?? ""),
  };
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
  async function sendText(text: string) {
    return call(target.kind === "group" ? "send_group_msg" : "send_private_msg", {
      ...(target.kind === "group" ? { group_id: id(target.id) } : { user_id: id(target.id) }),
      message: [{ type: "text", data: { text } }],
    });
  }

  // The answers a person can give are on messages this process sent. Keep the newest message per card and the cards that
  // are still waiting, so a bare `#1` is only accepted when there is no doubt which card it belongs to.
  const sentBefore = new Set<number>();
  const open = new Map<number, string>();
  const cardsByMessage = new Map<string, number>();
  function forget(card: number) {
    const message = open.get(card);
    if (message) cardsByMessage.delete(message);
    open.delete(card);
  }

  async function send(card: Card) {
    const sent = await sendText(words(card));
    const message = String(sent?.message_id ?? "");
    if (!message) throw new Error(`NapCat 没有确认消息发出：${JSON.stringify(sent).slice(0, 300)}`);
    sentBefore.add(card.id);
    if (card.state === "open") {
      open.set(card.id, message);
      cardsByMessage.set(message, card.id);
    }
    return `napcat-card-${card.id}`;
  }

  async function answer(reply: Reply) {
    const choice = choiceOf(reply.text);
    if (choice === null) return;
    const card = reply.reply ? cardsByMessage.get(reply.reply) : open.size === 1 ? open.keys().next().value : undefined;
    if (card === undefined) {
      // A bare number can't choose between cards, and silence would make the person think it worked.
      await sendText(
        reply.reply
          ? "这条消息不是本通道发出的卡片，请引用卡片消息再回复。"
          : "有几张卡片在等回答，请引用要回答的那条消息，再回复 #1、#2……",
      ).catch((error) => log(`NapCat 没法提示怎么回答：${error}`));
      return;
    }
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
        const reply = replyOf(payload, target);
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
