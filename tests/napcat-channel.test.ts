// NapCat's channel against a fake OneBot 11 server: a card reaches exactly the configured QQ user or group, only a `#N`
// reply to the card this channel sent answers it, a bare `#N` is refused when more than one card is waiting, and a lost
// delivery report doesn't put the card in the chat twice.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import napcat, { choiceOf, messageOf, replyOf, words } from "../plugins/napcat/channel.ts";
import type { Card } from "../host/channels.ts";

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "agent-autoloop.ts");
const stops: AbortController[] = [];
const homes: string[] = [];
after(() => stops.forEach((stop) => stop.abort()));
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

test("napcat: a card shows the rule, the words, numbered choices and the link", () => {
  const said = words({ ...base, rule: "清理磁盘" });
  assert.match(said, /清理磁盘/);
  assert.match(said, /占了 10 GB/);
  assert.match(said, /#1\. 删/);
  assert.match(said, /#2\. 留着/);
  assert.match(said, /直接回复 #1、#2/);
  assert.match(said, /https:\/\/hub\.test\/c\/x/);
  const done = words({ ...base, state: "done", choice: 0, result: "删了" });
  assert.match(done, /你选了「删」。已执行：删了/);
  assert.doesNotMatch(done, /#1\. 删/, "a settled card doesn't show choices again");
});

test("napcat: only a bare numbered choice answers, and a reply can quote its card", () => {
  assert.equal(choiceOf("#2"), 1);
  assert.equal(choiceOf("  # 12  "), 11);
  assert.equal(choiceOf("#0"), null);
  assert.equal(choiceOf("选 #2"), null, "words around a number could mean anything else");
  assert.deepEqual(
    messageOf([
      { type: "reply", data: { id: "M1" } },
      { type: "text", data: { text: "#2" } },
    ]),
    { text: "#2", reply: "M1" },
  );
  assert.deepEqual(messageOf(undefined, "[CQ:reply,id=M2] #1"), { text: " #1", reply: "M2" });
  const target = { kind: "user" as const, id: "123" };
  assert.equal(
    replyOf({ post_type: "message", message_type: "private", user_id: 123, message: "#1" }, target)?.user,
    "123",
  );
  assert.equal(
    replyOf({ post_type: "message", message_type: "private", user_id: 456, message: "#1" }, target),
    null,
    "another person's message is not this channel's",
  );
  assert.equal(
    replyOf({ post_type: "message", message_type: "group", group_id: 9, user_id: 123, message: "#1" }, target),
    null,
  );
});

type Received = { action: string; body: any };

/** A fake OneBot: HTTP API calls and a forward WebSocket that pushes messages into the channel. */
async function fakeOneBot() {
  const received: Received[] = [];
  let nextId = 100;
  let connected = () => {};
  const ready = new Promise<void>((resolve) => (connected = resolve));
  let socket: any = null;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    received.push({ action: request.url?.replace(/^\//, "") ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && /^\/send_(private|group)_msg$/.test(request.url ?? "")) {
      return response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: nextId++ } }));
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
    socket = raw;
    connected();
    raw.on("error", () => {});
    raw.on("data", (data: Buffer) => {
      // Complete the closing handshake, or Node's client keeps waiting instead of emitting `close`.
      if (data.length && (data[0] & 15) === 8) {
        raw.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
        raw.end();
      }
    });
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
      assert.ok(socket, "the channel connected first");
      const body = Buffer.from(JSON.stringify(value));
      const header =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    },
  };
}

function hubOf(cards: Card[], answered: Promise<void>, calls: unknown[][]) {
  return {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", ...args]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
}

test("napcat: a card goes to the configured user once, and an update sends no second card", async () => {
  const onebot = await fakeOneBot();
  const stop = new AbortController();
  stops.push(stop);
  const cards: Card[] = [base, { ...base, version: 2, ref: "napcat-card-5" }];
  const calls: unknown[][] = [];
  let finish = () => {};
  const answered = new Promise<void>((resolve) => (finish = resolve));
  const hub = hubOf(cards, answered, calls);
  const run = napcat({
    hub: hub as any,
    options: { url: onebot.http, ws: onebot.ws, user: "123" },
    log: () => {},
    signal: stop.signal,
  });
  await onebot.ready;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && calls.filter((call) => call[0] === "delivered").length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  stop.abort();
  finish();
  await run;
  const sends = onebot.received.filter(({ action }) => action === "send_private_msg");
  assert.equal(sends.length, 1, "an update sends no second message");
  assert.equal(sends[0].body.user_id, 123);
  assert.match(sends[0].body.message[0].data.text, /要不要删/);
  assert.deepEqual(calls, [
    ["delivered", 5, 1, "napcat-card-5"],
    ["delivered", 5, 2, "napcat-card-5"],
  ]);
  onebot.server.close();
});

test("napcat: a bare reply answers the only waiting card, and a quoted reply chooses between cards", async () => {
  const onebot = await fakeOneBot();
  const stop = new AbortController();
  stops.push(stop);
  const cards: Card[] = [
    { ...base, id: 5 },
    { ...base, id: 6 },
  ];
  const calls: unknown[][] = [];
  let done = () => {};
  const answered = new Promise<void>((resolve) => (done = resolve));
  const hub = hubOf(cards, answered, calls);
  const run = napcat({
    hub: hub as any,
    options: { url: onebot.http, ws: onebot.ws, user: "123" },
    log: () => {},
    signal: stop.signal,
  });
  await onebot.ready;
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(predicate(), "the expected call arrived");
  };
  await wait(() => calls.filter((call) => call[0] === "delivered").length === 2);
  onebot.say({ post_type: "message", message_type: "private", user_id: 123, message_id: 900, raw_message: "#2" });
  await wait(() =>
    onebot.received.some(({ action, body }) => action === "send_private_msg" && /引用/.test(body.message[0].data.text)),
  );
  assert.equal(calls.filter((call) => call[0] === "answer").length, 0, "two cards and no quote is not an answer");
  onebot.say({
    post_type: "message",
    message_type: "private",
    user_id: 123,
    message_id: 901,
    message: [
      { type: "reply", data: { id: "101" } },
      { type: "text", data: { text: "#2" } },
    ],
  });
  await wait(() => calls.some((call) => call[0] === "answer"));
  stop.abort();
  done();
  await run;
  assert.deepEqual(
    calls.find((call) => call[0] === "answer"),
    ["answer", 6, { choice: 1, by: "123", ref: "napcat-card-6" }],
  );
  onebot.server.close();
});

test("napcat: a group target sends to the group, and a missing target fails without guessing", async () => {
  const onebot = await fakeOneBot();
  const stop = new AbortController();
  stops.push(stop);
  const calls: unknown[][] = [];
  let done = () => {};
  const answered = new Promise<void>((resolve) => (done = resolve));
  const hub = hubOf([base], answered, calls);
  const run = napcat({
    hub: hub as any,
    options: { url: onebot.http, ws: onebot.ws, group: "456" },
    log: () => {},
    signal: stop.signal,
  });
  await onebot.ready;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !calls.some((call) => call[0] === "delivered")) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  stop.abort();
  done();
  await run;
  assert.equal(onebot.received.find(({ action }) => action === "send_group_msg")?.body.group_id, 456);
  onebot.server.close();

  const missing = new AbortController();
  stops.push(missing);
  await assert.rejects(
    napcat({
      hub: {
        async nextCard() {
          return { card: null };
        },
      } as any,
      options: { url: onebot.http, ws: onebot.ws },
      log: () => {},
      signal: missing.signal,
    }),
    /user 或 group/,
  );
});

test("napcat: an installed hub loads the built-in channel and calls OneBot", async () => {
  const onebot = await fakeOneBot();
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-napcat-home-"));
  homes.push(home);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_"))),
    AGENT_AUTOLOOP_HOME: home,
  };
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const key = async (kind: string, name: string) => {
    const made = await cli(["key", "new", kind, name]);
    assert.equal(made.status, 0, made.stderr);
    return made.stdout.trim().split("\n").at(-1)!;
  };
  const rules = JSON.parse(readFileSync(join(ROOT, "tests", "rules.fixture.json"), "utf8"));
  rules.channels = { napcat: { name: "QQ（NapCat）", answerers: ["123"] } };
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));
  const port = await freePort();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      hub: { listen: `127.0.0.1:${port}` },
      channels: {
        napcat: { key: await key("channel", "napcat"), url: onebot.http, ws: onebot.ws, user: "123" },
      },
      owner: await key("owner", "me"),
    }),
  );
  const up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "up"], { env, stdio: "ignore" });
  try {
    await Promise.race([
      onebot.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no connection")), 20_000)),
    ]);
    assert.ok(true, "the configured channel connected to OneBot");
  } finally {
    up.kill("SIGTERM");
    await new Promise((resolve) => up.once("exit", resolve));
    onebot.server.close();
  }
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
