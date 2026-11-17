// The outbox that replaces direct QQ delivery after the chat bot takes over the front door. Failure cases this guards: a
// card from another conversation is sent to the configured QQ or group instead of the owner; a completed task is downgraded
// to a silent notification so the robot cannot decide what to do; a card is confirmed before it actually reached the bot; an
// update is sent as a second message because the channel ignores the delivery ref.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { Card } from "../host/channels.ts";
import insoulforge, {
  headline,
  kindOf,
  modeOf,
  mustRelay,
  notificationOf,
  notificationsOf,
  parts,
  shouldSend,
  targetOf,
  words,
} from "../plugins/insoulforge/channel.ts";

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "notice",
  state: "open",
  title: "检查完成",
  text: "项目状态正常",
  options: [],
  recommend: null,
  choice: null,
  answer: null,
  result: null,
  link: null,
};

const stops: AbortController[] = [];
const servers: ReturnType<typeof createServer>[] = [];
after(() => {
  stops.forEach((stop) => stop.abort());
  servers.forEach((server) => {
    server.closeAllConnections();
    server.close();
  });
});

test("insoulforge: a card goes back to its originating QQ conversation, or the configured fallback", () => {
  assert.equal(targetOf({ ...base, reply: "qq-private-10001001" }), "private:10001001");
  assert.equal(targetOf({ ...base, reply: "qq-group-20002002" }), "group:20002002");
  assert.equal(targetOf(base, "private:10001001"), "private:10001001");
  assert.equal(targetOf(base), null, "without a fallback a source-less card cannot be delivered");
  assert.equal(targetOf({ ...base, reply: "qq-private-01" }, "private:10001001"), "private:10001001");
});

test("insoulforge: finished work and questions force a reply, progress is judged", () => {
  assert.equal(modeOf(base), "judge");
  assert.equal(modeOf({ ...base, kind: "ask", state: "open" }), "force");
  assert.equal(modeOf({ ...base, state: "done" }), "force");
  assert.match(
    notificationOf({ ...base, state: "done", result: "已修复" }, "private:10001001").text,
    /任务完成[\s\S]*已修复/,
  );
  assert.match(
    notificationOf({ ...base, state: "done" }, "private:10001001").text,
    /\[系统通知\][\s\S]*private:10001001/,
    "the system sender cannot provide current_session, so the notification names it",
  );
});

test("insoulforge: finished work and decisions tell the chat model to speak, progress may stay quiet", () => {
  assert.equal(mustRelay({ ...base, state: "done" }), true);
  assert.equal(mustRelay({ ...base, kind: "ask", state: "open" }), true);
  assert.equal(mustRelay({ ...base, kind: "notice", state: "closed", fyi: true }), true, "a receipt is still news");
  assert.equal(mustRelay(base), false, "an ordinary open notice is only progress");
  assert.match(notificationOf({ ...base, state: "done" }, "private:10001001").text, /必须转告用户/);
  assert.match(
    notificationOf({ ...base, kind: "notice", state: "closed", fyi: true }, "private:10001001").text,
    /必须转告用户/,
  );
  assert.match(notificationOf(base, "private:10001001").text, /可以保持安静/);
});

test("insoulforge: the outbox tags completion, questions and progress so the router need not infer them", () => {
  assert.equal(kindOf({ ...base, state: "done" }), "done");
  assert.equal(kindOf({ ...base, state: "closed", fyi: true }), "done");
  assert.equal(kindOf({ ...base, kind: "ask", state: "open" }), "ask");
  assert.equal(kindOf(base), "progress");
  assert.match(notificationOf({ ...base, state: "done" }, "private:1").text, /^\[Autoloop 状态\] 完成/);
  assert.match(notificationOf({ ...base, kind: "ask", state: "open" }, "private:1").text, /^\[Autoloop 状态\] 提问/);
  assert.match(notificationOf(base, "private:1").text, /^\[Autoloop 状态\] 进度/);
});

test("insoulforge: a restart skips cards from before it, but lets a delivered card update", () => {
  const since = { startedAt: Date.parse("2026-01-01T00:00:00Z"), sent: new Set<number>() };
  assert.equal(shouldSend({ ...base, id: 20, createdAt: "2025-12-31T23:59:59Z" }, since), false);
  assert.equal(shouldSend({ ...base, id: 21, createdAt: "2026-01-01T00:00:01Z" }, since), true);
  assert.equal(
    shouldSend({ ...base, id: 19, createdAt: "2025-12-31T23:59:59Z", ref: "insoulforge-card-19" }, since),
    true,
    "a card already delivered before the restart may still carry an update",
  );
  assert.equal(
    shouldSend({ ...base, id: 21, version: 2, createdAt: "2026-01-01T00:00:01Z" }, since),
    true,
    "once sent, its later versions are not treated as history",
  );
  since.sent.add(21);
  assert.equal(
    shouldSend({ ...base, id: 21, version: 2, createdAt: "2025-12-31T23:59:59Z" }, since),
    true,
    "after this process sends it, later versions keep flowing even if the timestamp is old",
  );
  assert.equal(shouldSend({ ...base, id: 22 }, since), true, "no timestamp means it cannot be proven historic");
});

test("insoulforge: a completion keeps the task name even when the rule shares it", () => {
  const card = {
    ...base,
    title: "QQ 通用任务",
    rule: "QQ 通用任务",
    text: "迁移连通性检查",
    state: "done" as const,
    result: "OK",
  };
  const text = notificationOf(card, "private:10001001").text;
  assert.match(text, /任务：QQ 通用任务/);
  assert.match(text, /结果：OK/);
  assert.match(text, /保留任务名、结果/);
});

test("insoulforge: another source's task is framed without pretending it came from this chat", () => {
  assert.match(headline(base), /需要你处理/);
  assert.match(headline({ ...base, state: "closed" }), /保持安静/);
  const asked = words({ ...base, kind: "ask", title: "选方案", text: "用哪个", options: ["甲", "乙"] });
  assert.match(asked, /需要你决定/);
  assert.match(asked, /1\. 甲/);
  assert.match(asked, /2\. 乙/);
  assert.doesNotMatch(asked, /#1/);
});

test("insoulforge: an update is confirmed without a second notification, and nothing is confirmed before send", async () => {
  const seen: any[] = [];
  const reports: unknown[][] = [];
  const server = createServer();
  servers.push(server);
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    setImmediate(() => socket.write(serverFrame({ type: "ready" })));
    let frame = Buffer.alloc(0);
    socket.on("data", (data) => {
      frame = Buffer.concat([frame, data]);
      for (;;) {
        if (frame.length < 2) return;
        const opcode = frame[0]! & 15;
        let length = frame[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (frame.length < 4) return;
          length = frame.readUInt16BE(2);
          offset = 4;
        }
        if (frame.length < offset + 4 + length) return;
        const mask = frame.subarray(offset, offset + 4);
        const body = Buffer.from(frame.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4]!;
        frame = frame.subarray(offset + 4 + length);
        if (opcode === 8) return socket.end();
        if (opcode === 1) seen.push(JSON.parse(body.toString()));
      }
    });
  });
  function serverFrame(value: unknown) {
    const payload = Buffer.from(JSON.stringify(value));
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/activities/ws`;
  const stop = new AbortController();
  stops.push(stop);
  const queue = [
    { ...base, id: 5, reply: "qq-private-10001001" },
    { ...base, id: 5, version: 2, ref: "insoulforge-card-5", reply: "qq-private-10001001" },
  ];
  const hub = {
    async nextCard() {
      if (queue.length) return { card: queue.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      reports.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      reports.push(["failed", ...args]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await insoulforge({
    hub: hub as any,
    options: { activityUrl: url, activityToken: "t".repeat(32), fallback: "private:10001001" },
    log: () => {},
    signal: stop.signal,
  });
  assert.equal(seen[0]?.type, "register");
  assert.equal(seen[0]?.name, "autoloop-outbox");
  const notices = seen.filter((message) => message.type === "notify");
  assert.equal(notices.length, 1, "the update must not be sent as another chat message");
  assert.equal(notices[0].target_session, "private:10001001");
  assert.equal(notices[0].mode, "judge");
  assert.deepEqual(reports[0], ["delivered", 5, 1, "insoulforge-card-5"]);
  assert.deepEqual(reports[1], ["delivered", 5, 2, "insoulforge-card-5"]);
  server.closeAllConnections();
  server.close();
});

test("insoulforge: idle outbox connections keep sending status heartbeats", async () => {
  const seen: any[] = [];
  const server = createServer();
  servers.push(server);
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    setImmediate(() => socket.write(serverFrame({ type: "ready" })));
    let frame = Buffer.alloc(0);
    socket.on("data", (data) => {
      frame = Buffer.concat([frame, data]);
      for (;;) {
        if (frame.length < 2) return;
        const opcode = frame[0]! & 15;
        let length = frame[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (frame.length < 4) return;
          length = frame.readUInt16BE(2);
          offset = 4;
        }
        if (frame.length < offset + 4 + length) return;
        const mask = frame.subarray(offset, offset + 4);
        const body = Buffer.from(frame.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4]!;
        frame = frame.subarray(offset + 4 + length);
        if (opcode === 8) return socket.end();
        if (opcode === 1) seen.push(JSON.parse(body.toString()));
      }
    });
  });
  function serverFrame(value: unknown) {
    const payload = Buffer.from(JSON.stringify(value));
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/activities/ws`;
  const stop = new AbortController();
  stops.push(stop);
  const hub = {
    async nextCard() {
      return new Promise((resolve) =>
        setTimeout(() => {
          stop.abort();
          resolve({ card: null });
        }, 80),
      );
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer() {
      return {};
    },
  };
  await insoulforge({
    hub: hub as any,
    options: {
      activityUrl: url,
      activityToken: "t".repeat(32),
      heartbeatMs: 1_000,
      fallback: "private:10001001",
    },
    log: () => {},
    signal: stop.signal,
  });
  const status = seen.filter((message) => message.type === "status");
  assert.equal(status.length, 1, "an idle connection must send a heartbeat");
  assert.equal(status[0].active, false);
  server.closeAllConnections();
  server.close();
});

test("insoulforge: a long report is sent in parts instead of being cut off at the chat app's limit", () => {
  const items = Array.from(
    { length: 90 },
    (_, index) => `**${index + 1}. 项目** — 节点 vantablack，目录 /root/work/p${index + 1}，状态在线，仅只读核对。`,
  );
  const card = { ...base, state: "done" as const, title: "QQ 通用任务", text: items.join("\n\n") };
  const notices = notificationsOf(card, "private:10001001");
  assert.ok(notices.length > 1, "a report longer than one message is split, not clipped");
  const said = notices.map((notice) => notice.text);
  const whole = said.join("\n");
  for (const item of items) assert.equal(whole.split(item).length - 1, 1, `每一项都要原样出现一次：${item}`);
  for (const [index, text] of said.entries()) {
    assert.ok(text.length < 4000, "each part fits a chat message");
    assert.match(text, new RegExp(`第 ${index + 1}/${notices.length} 段`));
    assert.match(text, /\[系统通知\] 会话：private:10001001/);
    assert.match(text, /必须转告用户/);
  }
  assert.ok(said.join("").includes(items.at(-1)!), "the last item still reaches the person");
});

test("insoulforge: splitting keeps whole lines, and only breaks a single overly long line", () => {
  assert.deepEqual(parts("短消息"), ["短消息"]);
  const long = "一".repeat(25);
  assert.deepEqual(parts(long, 10), ["一".repeat(10), "一".repeat(10), "一".repeat(5)]);
  const lines = ["a".repeat(6), "b".repeat(6), "c".repeat(6)].join("\n");
  assert.deepEqual(parts(lines, 13), ["aaaaaaaaaa".slice(0, 6) + "\n" + "b".repeat(6), "c".repeat(6)]);
});
