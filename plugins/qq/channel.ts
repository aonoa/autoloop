// QQ, through the official QQ Bot API: a Gateway WebSocket brings messages and button clicks back, so this machine needs no
// public address. It holds one bot's access token and no SDK, using only Node's WebSocket and fetch.
//   "channels": { "qq": { "key": "…", "appId": "…", "clientSecret": "…", "user": "USER_OPENID" } } in config.json
//   "channels": { "qq": { "name": "QQ", "answerers": ["USER_OPENID"] } } in rules.json: who may answer.
// A group target is `"group": "GROUP_OPENID"` instead of `user`; a card reaches exactly one of them.
import type { Card, ChannelContext } from "../../host/channels.ts";

const API = "https://api.bot.qq.com";
// GROUP_AND_C2C_EVENT | INTERACTION: messages to the bot and the clicks on its inline keyboard.
const INTENTS = (1 << 25) | (1 << 26);

type Payload = { id?: string; op: number; s?: number; t?: string; d?: any };
type Target = { kind: "user" | "group"; openid: string };
type Session = { id: string; seq: number };
/** What QQ lets a reply follow: an inbound message's id, or the id of the event that carried it. */
type Reply = { message?: string; event?: string };

/** The words of a card, with which rule sent it, in the order a person reads them. */
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
  const choices = card.state === "open" ? card.options.map((option, index) => `${index + 1}. ${option}`) : [];
  // QQ's Markdown is drawn: a link in what an Agent wrote would look like part of the card, so keep it as words.
  const text = card.text.replaceAll("](", "］(").replaceAll("<", "＜");
  return [card.title, rule ? `来源：${rule}` : "", text, outcome, note, ...choices, card.link ?? ""]
    .filter(Boolean)
    .join("\n\n");
}

/** One callback button per option, with the card and choice in its data; QQ caps a label at ten characters. */
export function keyboard(card: Card) {
  if (card.state !== "open" || !card.options.length) return undefined;
  const buttons = card.options.map((option, index) => ({
    id: `card-${card.id}-${index}`,
    render_data: {
      label: [...option].slice(0, 10).join(""),
      visited_label: "已选",
      style: index === card.recommend ? 1 : 0,
    },
    action: { type: 1, data: reference(card, index), permission: { type: 2 } },
  }));
  return { content: { rows: [{ buttons }] } };
}

// QQ's interaction doesn't reliably carry the sent message's id, so the button carries a stable ref of its own. The hub
// only compares refs it handed to this channel; it never takes this one for a QQ message id.
const reference = (card: Card, choice: number) => JSON.stringify({ card: card.id, choice, ref: `qq-card-${card.id}` });

/** The one person or group this card reaches: a reply can't be sent to both, and guessing would reach the wrong one. */
function targetOf(options: Record<string, unknown>): Target {
  const user = typeof options.user === "string" ? options.user : "";
  const group = typeof options.group === "string" ? options.group : "";
  if (Boolean(user) === Boolean(group)) throw new Error("QQ 通道要在 config.json 写 user 或 group（只能写一个）");
  return user ? { kind: "user", openid: user } : { kind: "group", openid: group };
}

export function accessTokenResponse(body: any) {
  if (typeof body?.access_token !== "string" || !body.access_token) {
    throw new Error(`QQ 没有给出 access_token：${JSON.stringify(body).slice(0, 300)}`);
  }
  return { token: body.access_token as string, expires: Number(body.expires_in) || 7200 };
}

/** Which target a click answers, and which card: only a button's data that names one of this card's options counts. */
export function clickOf(payload: Payload) {
  if (payload.t !== "INTERACTION_CREATE" || payload.d?.type !== 11) return null;
  const data = payload.d.data?.resolved;
  let given: any;
  try {
    given = JSON.parse(data?.button_data ?? "");
  } catch {
    return null;
  }
  const card = Number(given?.card);
  const choice = Number(given?.choice);
  const ref = typeof given?.ref === "string" ? given.ref : "";
  if (!Number.isInteger(card) || !Number.isInteger(choice) || choice < 0 || ref !== `qq-card-${card}`) return null;
  return {
    id: String(payload.id ?? ""),
    interaction: String(payload.d.id ?? ""),
    card,
    choice,
    by: String(payload.d.user_openid ?? payload.d.group_member_openid ?? ""),
    message: String(data?.message_id ?? ""),
    ref,
    scene: payload.d.scene === "group" ? ("group" as const) : ("user" as const),
  };
}

export default async function qq({ hub, options, log, signal }: ChannelContext) {
  const appId = typeof options.appId === "string" ? options.appId : "";
  const secret = typeof options.clientSecret === "string" ? options.clientSecret : "";
  if (!appId || !secret) throw new Error("QQ 通道要在 config.json 写 appId 和 clientSecret");
  const api = (typeof options.api === "string" ? options.api : API).replace(/\/$/, "");
  let token = "";
  let expiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < expiresAt) return token;
    const response = await fetch(`${api}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, clientSecret: secret }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`QQ access_token 返回 ${response.status}`);
    const got = accessTokenResponse(body);
    token = got.token;
    // It's good for two hours; take a new one a minute before it goes, so a card never fails on the boundary.
    expiresAt = Date.now() + Math.max(30, got.expires - 60) * 1000;
    return token;
  }

  const call = async (method: string, path: string, body?: unknown, query = "") => {
    const response = await fetch(`${api}${path}${query}`, {
      method,
      headers: { authorization: `QQBot ${await accessToken()}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`QQ ${method} ${path} 返回 ${response.status}：${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };

  // QQ lets a bot answer an inbound message or event for a short while without counting against proactive limits. Remember
  // the newest one from the person or group this channel reaches; a card sent later falls back to a proactive message.
  let reply: Reply = {};

  async function send(card: Card) {
    const target = targetOf(options);
    const context = reply;
    reply = {};
    const body: Record<string, unknown> = {
      // Markdown keeps the rule, the text and the numbered choices legible; QQ draws raw addresses as links.
      msg_type: 2,
      markdown: { content: words(card) },
      ...(keyboard(card) && { keyboard: keyboard(card) }),
      ...(context.message ? { msg_id: context.message, msg_seq: 1 } : context.event ? { event_id: context.event } : {}),
    };
    const path =
      target.kind === "user"
        ? `/v2/users/${encodeURIComponent(target.openid)}/messages`
        : `/v2/groups/${encodeURIComponent(target.openid)}/messages`;
    const result = await call("POST", path, body);
    // The ref is what a click must name: the hub refuses an answer that points at another message. QQ has no edit call, so
    // a later version of the card reports this same message again rather than sending a second one.
    if (!result?.id) throw new Error(`QQ 没有确认消息发出：${JSON.stringify(result).slice(0, 300)}`);
    return `qq-card-${card.id}`;
  }

  async function acknowledge(interaction: string, code = 0) {
    if (!interaction) return;
    await call("PUT", `/interactions/${encodeURIComponent(interaction)}`, { code }).catch((error) => {
      // The click already reached the hub; a failed acknowledgement only leaves the client loading until its own timeout.
      log(`QQ 互动 ${interaction} 没回应成功：${error}`);
    });
  }

  async function answer(click: NonNullable<ReturnType<typeof clickOf>>) {
    try {
      await hub.answer(click.card, {
        choice: click.choice,
        by: click.by,
        ref: click.ref,
      });
    } finally {
      await acknowledge(click.interaction);
    }
  }

  // Clicks arrive close together: answer one after another, so two can't race on the same card before the first lands.
  let clicking = Promise.resolve();

  /** One Gateway connection; it returns the session to resume when the socket closes, and the caller reconnects. */
  function gateway(url: string, previous: Session | null) {
    return new Promise<Session | null>((resolve, reject) => {
      const socket = new WebSocket(url);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let seq = previous?.seq ?? 0;
      let opened = false;
      let session: Session | null = previous;
      let invalid = false;
      const stop = () => {
        if (heartbeat) clearInterval(heartbeat);
        socket.close();
      };
      signal.addEventListener("abort", stop, { once: true });
      socket.addEventListener("message", (event) => {
        let payload: Payload;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          log("QQ Gateway 发来一段读不懂的数据");
          return;
        }
        if (payload.s !== undefined) seq = payload.s;
        if (payload.op === 10) {
          const every = Number(payload.d?.heartbeat_interval) || 45_000;
          const beat = () => socket.send(JSON.stringify({ op: 1, d: seq || null }));
          if (previous)
            socket.send(
              JSON.stringify({ op: 6, d: { token: `QQBot ${token}`, session_id: previous.id, seq: previous.seq } }),
            );
          else
            socket.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `QQBot ${token}`,
                  intents: INTENTS,
                  shard: [0, 1],
                  properties: { $os: process.platform, $browser: "agent-autoloop", $device: "agent-autoloop" },
                },
              }),
            );
          beat();
          heartbeat = setInterval(beat, every);
          return;
        }
        if (payload.op === 7 || payload.op === 9) {
          if (payload.op === 9) invalid = true;
          stop();
          return;
        }
        if (payload.op !== 0) return;
        if (payload.t === "READY") {
          session = { id: String(payload.d?.session_id ?? ""), seq: payload.s ?? 0 };
          opened = true;
          return;
        }
        if (payload.t === "C2C_MESSAGE_CREATE") {
          // A direct message is a way to reach this bot, not a card answer: cards only take a click or the words on their
          // link. Its id still lets the next card be a passive reply, which isn't limited like a proactive message.
          if (!options.group) reply = { message: String(payload.d?.id ?? ""), event: String(payload.id ?? "") };
          log(
            `QQ 单聊消息（${payload.d?.author?.user_openid ?? "未知用户"}）：${String(payload.d?.content ?? "").slice(0, 100)}`,
          );
          return;
        }
        if (payload.t === "GROUP_AT_MESSAGE_CREATE" && options.group) {
          reply = { message: String(payload.d?.id ?? ""), event: String(payload.id ?? "") };
          return;
        }
        const click = clickOf(payload);
        if (click) {
          reply = { event: String(payload.id ?? "") };
          clicking = clicking.then(() => answer(click)).catch((error) => log(`QQ 点击没有回答：${error}`));
        }
      });
      socket.addEventListener("error", () => {
        if (!opened) reject(new Error("QQ Gateway 连不上"));
      });
      socket.addEventListener("close", () => {
        if (heartbeat) clearInterval(heartbeat);
        signal.removeEventListener("abort", stop);
        if (opened) resolve(invalid ? null : session ? { ...session, seq: Math.max(session.seq, seq) } : null);
        else reject(new Error("QQ Gateway 断开了"));
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
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      // A message can't be changed after QQ accepts it, and a second message with the same buttons is worse: report the
      // one already there, so the version moves without the person seeing the card twice.
      if (card.ref) {
        await hub.delivered(card.id, card.version, card.ref);
        continue;
      }
      try {
        const ref = await send(card);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`卡片 ${card.id} 没发出：${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  let session: Session | null = null;
  const sending = deliver();
  while (!signal.aborted) {
    try {
      const gatewayInfo = await call("GET", "/gateway");
      const url = typeof gatewayInfo?.url === "string" ? gatewayInfo.url : "";
      if (!url) throw new Error("QQ 没有给出 Gateway 地址");
      session = await gateway(url, session);
    } catch (error) {
      log(`QQ Gateway：${error}`);
      session = null;
    }
    await sleep(5_000, signal);
  }
  await sending;
}

/** A pause that ends as soon as the channel is stopped: a shutdown shouldn't wait out a reconnect delay. */
function sleep(ms: number, signal: AbortSignal) {
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
