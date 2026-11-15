// A dedicated QQ account, end to end: a private task becomes an event, a card goes back to that person, their numbered
// reply resumes the work, and the final notice returns to the same private chat. Group messages and other senders are
// ignored. The QQ source runs through the same channel loader `up` uses, so a missing channel entry fails here too.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { beforeCleanup, setup } from "./helpers.ts";

const home = setup("qq-private");
const rules = {
  timezone: "Asia/Shanghai",
  sources: { qq: { name: "QQ 私聊", policy: { allowlist: ["10001"] } } },
  agents: { worker: { name: "甲", worker: "w1", use: "command", command: ["true"] } },
  channels: { napcat: { name: "QQ（NapCat）", answerers: ["10001"] } },
  rules: [
    {
      name: "QQ 私聊任务",
      when: { source: "qq", types: ["qq.task", "card.answered"] },
      to: "worker",
      cwd: "~/qq-private",
      prompt: "处理私聊里的任务。",
      tell: "always",
    },
  ],
};
const rulesFile = join(home, "rules.json");
writeFileSync(rulesFile, JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;

const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const { loadChannel } = await import("../host/channels.ts");
const { hubClient } = await import("../protocol/client.ts");
const napcat = (await import("../plugins/napcat/channel.ts")).default;

beforeCleanup.push(() => {
  if (hub.db.isOpen) hub.db.close();
});

const stop = new AbortController();
after(() => stop.abort());

type Received = { action: string; body: any; id?: number };

/** A fake OneBot that serves both the source and the channel, and pushes messages to both. */
async function fakeOneBot() {
  const received: Received[] = [];
  const sockets = new Set<any>();
  let nextId = 500;
  let connected = () => {};
  const ready = new Promise<void>((resolve) => (connected = resolve));
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const action = request.url?.replace(/^\//, "") ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && /^send_(private|group)_msg$/.test(action)) {
      const id = nextId++;
      received.push({ action, body, id });
      return response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: id } }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ status: "failed", retcode: 1404, data: null }));
  });
  server.on("upgrade", (request, raw) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    raw.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(raw);
    raw.on("error", () => {});
    raw.on("close", () => sockets.delete(raw));
    raw.on("data", (data: Buffer) => {
      if (data.length && (data[0] & 15) === 8) {
        raw.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
        raw.end();
      }
    });
    if (sockets.size === 2) connected();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    received,
    ready,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    say(value: unknown) {
      assert.equal(sockets.size, 2, "both the source and the channel connected first");
      const body = Buffer.from(JSON.stringify(value));
      const header =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      for (const socket of sockets) socket.write(Buffer.concat([header, body]));
    },
  };
}

async function waitFor<T>(what: string, look: () => T | undefined, timeout = 8_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const seen = look();
    if (seen) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等不到：${what}`);
}

/** Hands in a receipt through the same HTTP door a worker uses, so long polls wake as they do in production. */
async function result(url: string, job: { run: number; token: string }, body: unknown) {
  const response = await fetch(`${url}/v1/runs/${job.run}/result`, {
    method: "POST",
    headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
}

test("a private task, its card, the answer and the final notice all stay with the person who sent it", async () => {
  const onebot = await fakeOneBot();
  const sourceKey = hub.addKey("source", "qq");
  const channelKey = hub.addKey("channel", "napcat");
  hub.addKey("worker", "w1");
  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Each plugin keeps a long poll and a WebSocket open; both must be stopped before the test process can exit.
  const plugins = new AbortController();
  // The real channel asks for a 50-second poll. Tests end sooner, and a client without the stop signal would keep the
  // process alive until that request timed out; a short wait still exercises the same long-poll path.
  const testHub = (key: string) => {
    const client = hubClient(url, key);
    return { ...client, nextCard: (wait: number) => client.nextCard(Math.min(wait, 1)) };
  };
  const run = (async () => {
    const qqSource = await loadChannel("qq-source");
    await Promise.all([
      qqSource({
        hub: testHub(channelKey),
        options: {
          url,
          ws: onebot.ws,
          sourceKey,
          allowed: ["10001"],
          bot: "30003003",
        },
        log: () => {},
        signal: plugins.signal,
      }),
      napcat({
        hub: testHub(channelKey),
        options: { url: onebot.http, ws: onebot.ws, user: "99999" },
        log: () => {},
        signal: plugins.signal,
      }),
    ]);
  })();
  try {
    // If either plugin fails to start, `run` rejects and the test must not wait for a connection that will never come.
    await Promise.race([onebot.ready, run]);
    onebot.say({
      post_type: "message",
      message_type: "private",
      self_id: 30003003,
      user_id: 10001,
      message_id: 9001,
      raw_message: "整理一下今天的日志",
      message: [{ type: "text", data: { text: "整理一下今天的日志" } }],
    });
    const event = await waitFor("the private task", () => hub.one<any>("SELECT * FROM events WHERE type = 'qq.task'"));
    assert.deepEqual(
      [event.actor, event.reply, event.subject, event.detail],
      ["10001", "qq-private-10001", "qq-private-10001", "整理一下今天的日志"],
    );
    const job = hub.claimNext("w1", "private-1")!;
    assert.equal(job.rule.name, "QQ 私聊任务");
    await result(url, job, {
      outcome: "done",
      summary: "需要你选一个范围",
      ask: [{ title: "整理哪些日志", text: "请选择范围", options: ["今天的", "最近三天"] }],
    });
    const cardMessage = await waitFor("the card in the private chat", () =>
      onebot.received.find(({ action, body }) => action === "send_private_msg" && body.user_id === 10001),
    );
    assert.match(cardMessage.body.message[0].data.text, /整理哪些日志/);
    onebot.say({
      post_type: "message",
      message_type: "private",
      self_id: 30003003,
      user_id: 10001,
      message_id: 9002,
      message: [
        { type: "reply", data: { id: String(cardMessage.id) } },
        { type: "text", data: { text: "#1" } },
      ],
    });
    const answering = await waitFor("the answered run", () => hub.claimNext("w1", "private-2") ?? undefined);
    assert.deepEqual(
      answering.context.events.map((item) => item.type),
      ["card.answered"],
    );
    await result(url, answering, { outcome: "done", summary: "今天的日志整理完了" });
    const notice = await waitFor("the final notice", () =>
      onebot.received.find(
        ({ action, body }) =>
          action === "send_private_msg" &&
          body.user_id === 10001 &&
          /今天的日志整理完了/.test(body.message[0].data.text),
      ),
    );
    assert.match(notice.body.message[0].data.text, /今天的日志整理完了/);
    assert.equal(
      onebot.received.filter(({ action }) => action === "send_group_msg").length,
      0,
      "nothing goes to a group",
    );

    onebot.say({
      post_type: "message",
      message_type: "private",
      self_id: 30003003,
      user_id: 20002,
      message_id: 9003,
      raw_message: "我也来派个任务",
      message: [{ type: "text", data: { text: "我也来派个任务" } }],
    });
    onebot.say({
      post_type: "message",
      message_type: "group",
      self_id: 30003003,
      group_id: 20002002,
      user_id: 10001,
      message_id: 9004,
      raw_message: "群里派任务",
      message: [{ type: "text", data: { text: "群里派任务" } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      hub.one<{ count: number }>("SELECT COUNT(*) AS count FROM events WHERE type = 'qq.task'")!.count,
      1,
      "an unlisted sender and a group message make no task",
    );
  } finally {
    plugins.abort();
    await run.catch(() => {});
    server.closeAllConnections();
    server.close();
    onebot.server.close();
  }
});
