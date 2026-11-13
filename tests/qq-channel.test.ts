// QQ's channel against a fake OpenAPI and Gateway: the access token is fetched once and refreshed, a card goes to exactly
// the configured user or group, a click answers with the stable ref from its button, and an update never sends a second card.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import qq, { accessTokenResponse, clickOf, keyboard, words } from "../plugins/qq/channel.ts";
import type { Card } from "../host/channels.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "agent-autoloop.ts");

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

const stops: AbortController[] = [];
const homes: string[] = [];
after(() => {
  stops.forEach((stop) => stop.abort());
  homes.forEach((home) => rmSync(home, { recursive: true, force: true }));
});

test("qq: a card shows the rule, the words, the options and the link", () => {
  const said = words({ ...base, rule: "清理磁盘" });
  assert.match(said, /清理磁盘/);
  assert.match(said, /占了 10 GB/);
  assert.match(said, /1\. 删/);
  assert.match(said, /2\. 留着/);
  assert.match(said, /https:\/\/hub\.test\/c\/x/);
  const done = words({ ...base, rule: "清理磁盘", state: "done", choice: 0, result: "删了" });
  assert.match(done, /你选了「删」。已执行：删了/);
  assert.doesNotMatch(done, /1\. 删/, "a settled card doesn't show options again");
  const notice = words({ ...base, kind: "notice", state: "closed", options: [], result: "已处理", answer: "清空了" });
  assert.match(notice, /已处理/);
  assert.match(notice, /处理说明：清空了/);
});

test("qq: an open card gets one callback button per option, and a settled one gets none", () => {
  const rows = keyboard(base)!.content.rows[0].buttons;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].render_data.label, "删");
  assert.equal(rows[0].render_data.style, 0);
  assert.equal(rows[1].render_data.style, 1, "the recommended option is outlined blue");
  assert.deepEqual(JSON.parse(rows[1].action.data), { card: 5, choice: 1, ref: "qq-card-5" });
  assert.equal(keyboard({ ...base, state: "decided", choice: 1 }), undefined);
  assert.equal(keyboard({ ...base, kind: "notice", options: [] }), undefined);
  const long = keyboard({ ...base, options: ["一二三四五六七八九十十一"] })!.content.rows[0].buttons[0];
  assert.equal(long.render_data.label, "一二三四五六七八九十", "QQ truncates a button label at ten characters");
});

test("qq: only a button click on an open card's option is an answer", () => {
  const click = (button_data: unknown, extra: Record<string, unknown> = {}) => ({
    id: "outer",
    op: 0,
    s: 1,
    t: "INTERACTION_CREATE",
    d: {
      id: "interaction-1",
      type: 11,
      scene: "c2c",
      user_openid: "U1",
      data: { resolved: { button_data, message_id: "M1", ...extra } },
    },
  });
  assert.deepEqual(clickOf(click(JSON.stringify({ card: 5, choice: 1, ref: "qq-card-5" })) as any), {
    id: "outer",
    interaction: "interaction-1",
    card: 5,
    choice: 1,
    by: "U1",
    message: "M1",
    ref: "qq-card-5",
    scene: "user",
  });
  assert.equal(clickOf(click("not json") as any), null);
  assert.equal(
    clickOf({ ...click(JSON.stringify({ card: 5, choice: 1, ref: "qq-card-5" })), t: "C2C_MESSAGE_CREATE" } as any),
    null,
  );
  assert.equal(clickOf(click(JSON.stringify({ card: 5, choice: -1 })) as any), null);
  assert.equal(clickOf(click(JSON.stringify({ choice: 1 })) as any), null);
  assert.equal(
    clickOf(click(JSON.stringify({ card: 5, choice: 1, ref: "another-card" })) as any),
    null,
    "a ref for another card is not this card's answer",
  );
});

test("qq: a token without access_token says what came back", () => {
  assert.deepEqual(accessTokenResponse({ access_token: "token", expires_in: "7200" }), {
    token: "token",
    expires: 7200,
  });
  assert.throws(() => accessTokenResponse({ code: 100007, message: "appid invalid" }), /appid invalid/);
});

type Received = { method: string; path: string; body: any };

/** A Gateway good enough for a test: a handshake, hello, READY and one button click. */
function fakeGateway(): Promise<{ server: ReturnType<typeof createServer>; port: number; identified: Promise<any> }> {
  const server = createServer();
  let sawIdentify = (_value: any) => {};
  const identified = new Promise<any>((resolve) => (sawIdentify = resolve));
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      const header =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    };
    send({ op: 10, d: { heartbeat_interval: 45_000 } });
    let pending = Buffer.alloc(0);
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15;
        let length = pending[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        }
        if (pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4);
        const text = pending
          .subarray(offset + 4, offset + 4 + length)
          .map((byte, index) => byte ^ mask[index % 4])
          .toString();
        pending = pending.subarray(offset + 4 + length);
        if (opcode === 8) return socket.end();
        if (opcode !== 1) continue;
        const payload = JSON.parse(text);
        if (payload.op === 2) {
          sawIdentify(payload);
          send({ op: 0, s: 1, t: "READY", d: { session_id: "SESSION", user: { id: "BOT" } } });
          send({
            op: 0,
            s: 2,
            t: "INTERACTION_CREATE",
            id: "event-1",
            d: {
              id: "interaction-1",
              type: 11,
              scene: "c2c",
              user_openid: "U1",
              data: { resolved: { button_data: JSON.stringify({ card: 5, choice: 1, ref: "qq-card-5" }) } },
            },
          });
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, identified })),
  );
}

/** A fake QQ: token, gateway URL, send, and interaction acknowledgement. There is no Gateway: the channel stays on sends. */
async function fakeQq(gateway = "") {
  const received: Received[] = [];
  let nextId = 100;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    received.push({ method: request.method ?? "", path: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/app/getAppAccessToken")
      return response.end(JSON.stringify({ access_token: "TOKEN", expires_in: 7200 }));
    if (request.url === "/gateway") return response.end(JSON.stringify({ url: gateway }));
    if (request.method === "PUT" && request.url?.startsWith("/interactions/")) return response.end(JSON.stringify({}));
    if (request.method === "POST" && /^\/v2\/(users|groups)\//.test(request.url ?? ""))
      return response.end(JSON.stringify({ id: `MSG-${nextId++}` }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, received };
}

test("qq: a card is sent once to the configured user, and an update reports the first message again", async () => {
  const qqServer = await fakeQq();
  const stop = new AbortController();
  stops.push(stop);
  const cards: (Card | null)[] = [base, { ...base, version: 2, ref: "qq-card-5" }, null];
  const reported: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      reported.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      reported.push(["failed", ...args]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await qq({
    hub: hub as any,
    options: { appId: "APP", clientSecret: "SECRET", user: "U1", api: `http://127.0.0.1:${qqServer.port}` },
    log: () => {},
    signal: stop.signal,
  });
  const sends = qqServer.received.filter(({ method, path }) => method === "POST" && path.startsWith("/v2/users/"));
  assert.equal(sends.length, 1, "an update sends no second message");
  assert.equal(sends[0].path, "/v2/users/U1/messages");
  assert.equal(sends[0].body.msg_type, 2);
  assert.match(sends[0].body.markdown.content, /要不要删/);
  assert.equal(sends[0].body.keyboard.content.rows[0].buttons.length, 2);
  assert.deepEqual(reported, [
    ["delivered", 5, 1, "qq-card-5"],
    ["delivered", 5, 2, "qq-card-5"],
  ]);
  assert.equal(qqServer.received.filter(({ path }) => path === "/gateway").length, 1);
  qqServer.server.close();
});

test("qq: a group target sends to the group, and a missing target fails the card instead of guessing", async () => {
  const qqServer = await fakeQq();
  const stop = new AbortController();
  stops.push(stop);
  const cards: (Card | null)[] = [base, null];
  const reported: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      reported.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      reported.push(["failed", ...args]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await qq({
    hub: hub as any,
    options: { appId: "APP", clientSecret: "SECRET", group: "G1", api: `http://127.0.0.1:${qqServer.port}` },
    log: () => {},
    signal: stop.signal,
  });
  assert.ok(qqServer.received.some(({ method, path }) => method === "POST" && path === "/v2/groups/G1/messages"));
  qqServer.server.close();

  const missing = new AbortController();
  stops.push(missing);
  const failed: unknown[][] = [];
  await qq({
    hub: {
      async nextCard() {
        missing.abort();
        return { card: base };
      },
      async failed(...args: unknown[]) {
        failed.push(args);
        return {};
      },
    } as any,
    options: { appId: "APP", clientSecret: "SECRET", api: `http://127.0.0.1:${qqServer.port}` },
    log: () => {},
    signal: missing.signal,
  });
  assert.match(String(failed[0][2]), /user 或 group/);
});

test("qq: a Gateway button click answers its card and acknowledges the interaction", async () => {
  const gateway = await fakeGateway();
  const qqServer = await fakeQq(`ws://127.0.0.1:${gateway.port}`);
  const stop = new AbortController();
  stops.push(stop);
  const answers: unknown[][] = [];
  let clicked = () => {};
  const answered = new Promise<void>((resolve) => (clicked = resolve));
  const hub = {
    async nextCard() {
      await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      stop.abort();
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed(...args: unknown[]) {
      assert.fail(`failed: ${args}`);
    },
    async answer(...args: unknown[]) {
      answers.push(args);
      clicked();
      return { changed: true };
    },
  };
  await qq({
    hub: hub as any,
    options: { appId: "APP", clientSecret: "SECRET", user: "U1", api: `http://127.0.0.1:${qqServer.port}` },
    log: () => {},
    signal: stop.signal,
  });
  assert.deepEqual(answers, [[5, { choice: 1, by: "U1", ref: "qq-card-5" }]]);
  const identify = await gateway.identified;
  assert.equal(identify.d.token, "QQBot TOKEN");
  assert.equal(identify.d.intents, (1 << 25) | (1 << 26));
  assert.deepEqual(identify.d.shard, [0, 1]);
  assert.ok(qqServer.received.some(({ method, path }) => method === "PUT" && path === "/interactions/interaction-1"));
  gateway.server.close();
  qqServer.server.close();
});

test("qq: an installed hub loads the built-in channel and calls the platform", async () => {
  const qqServer = await fakeQq();
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-qq-home-"));
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
  rules.channels = { qq: { name: "QQ", answerers: ["U1"] } };
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));
  const port = await freePort();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      hub: { listen: `127.0.0.1:${port}` },
      channels: {
        qq: {
          key: await key("channel", "qq"),
          appId: "APP",
          clientSecret: "SECRET",
          user: "U1",
          api: `http://127.0.0.1:${qqServer.port}`,
        },
      },
      owner: await key("owner", "me"),
    }),
  );
  const up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "up"], { env, stdio: "ignore" });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !qqServer.received.some(({ path }) => path === "/app/getAppAccessToken")) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      qqServer.received.some(({ path, body }) => path === "/app/getAppAccessToken" && body.appId === "APP"),
      "the configured channel fetched the bot token",
    );
  } finally {
    up.kill("SIGTERM");
    await new Promise((resolve) => up.once("exit", resolve));
    qqServer.server.close();
  }
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
