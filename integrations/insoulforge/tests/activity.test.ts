// Failure cases this file guards: a target session not on the allowlist is accepted; two projects share one lane; a status
// shows another chat's cards; an answer for someone else's card is recorded; an Activity request with a bad action throws
// and kills the socket; the WebSocket handshake drops the Authorization header.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import {
  createService,
  eventOf,
  instructions,
  laneOf,
  parseConfig,
  permittedSender,
  permittedOperators,
  senderOf,
  serve,
  statusOf,
  targetOf,
} from "../activity.ts";
import { open } from "../ws.ts";

const config = parseConfig({
  activity: { url: "ws://127.0.0.1:1/activities/ws", token: "a".repeat(32) },
  hub: { url: "http://127.0.0.1:1", sourceKey: "source", ownerKey: "owner" },
  allow: { private: ["1991849113"], groups: ["742118793"], actor: "1991849113", senders: ["1991849113"] },
  projects: {
    shop: { description: "商城", rule: "QQ 任务" },
    site: { description: "官网", rule: "QQ 任务" },
    general: { description: "通用任务：天气、资料、新闻等，不属于任何代码仓库", rule: "QQ 通用任务" },
  },
});

test("a target must name an allowed chat, not merely look like one", () => {
  assert.equal(targetOf("group:742118793", config), "group:742118793");
  assert.equal(targetOf("private:1991849113", config), "private:1991849113");
  assert.throws(() => targetOf("group:999", config), /不在允许范围/);
  assert.throws(() => targetOf("742118793", config), /target_session/);
  assert.throws(() => targetOf("group:0742118793", config), /target_session/);
  assert.throws(() => targetOf("qq-group-742118793", config), /target_session/);
});

test("the configured operator is the actor, never the group id supplied as target_session", () => {
  const group = eventOf("group:742118793", "shop", "修一下", config.allow.actor);
  const privateChat = eventOf("private:1991849113", "shop", "修一下", config.allow.actor);
  assert.equal(group.actor, config.allow.actor);
  assert.equal(privateChat.actor, config.allow.actor);
  assert.throws(
    () => parseConfig({ ...JSON.parse(JSON.stringify(config)), allow: { ...config.allow, actor: "群主" } }),
    /allow\.actor/,
  );
  assert.throws(
    () => parseConfig({ ...JSON.parse(JSON.stringify(config)), allow: { ...config.allow, senders: ["群主"] } }),
    /allow\.senders/,
  );
});

test("every submit needs the injected sender; a private chat must match its target", () => {
  assert.equal(senderOf("private:1991849113", { sender_id: "1991849113" }, config), "1991849113");
  assert.throws(() => senderOf("private:1991849113", undefined, config), /私聊请求缺少可信发送人/);
  assert.throws(() => senderOf("private:1991849113", { sender_id: "12345" }, config), /与会话不一致/);
  assert.equal(senderOf("group:742118793", { sender_id: "1991849113" }, config), "1991849113");
  assert.throws(() => senderOf("group:742118793", undefined, config), /缺少可信发送人/);
  assert.throws(() => senderOf("group:742118793", { sender_id: "abc" }, config), /身份无效/);
  assert.equal(permittedSender("1991849113", "group:742118793", config), true);
  assert.equal(permittedSender("12345", "group:742118793", config), false);
  assert.equal(permittedSender("12345", "private:1991849113", config), false);
  const delegated = parseConfig({
    ...JSON.parse(JSON.stringify(config)),
    allow: { ...config.allow, private: ["1991849113"], groups: ["742118793"], senders: ["1991849113", "12345"] },
  });
  assert.deepEqual(permittedOperators(delegated), ["1991849113", "12345"]);
  assert.equal(permittedSender("12345", "private:1991849113", delegated), true);
  assert.equal(permittedSender("12345", "group:742118793", delegated), true);
});

test("an unauthorized member cannot enumerate projects", async () => {
  const service = createService(config, {
    submit: async () => ({}),
    outcome: async () => ({ runs: [] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({}),
  });
  assert.deepEqual(await service.handle({ action: "projects" }), {
    success: false,
    error: "群聊请求缺少可信发送人身份，已拒绝",
  });
  assert.deepEqual(await service.handle({ action: "projects" }, { sender_id: "12345" }), {
    success: false,
    error: "这个发送人没有查看项目的权限",
  });
  const allowed = await service.handle({ action: "projects" }, { sender_id: "1991849113" });
  assert.equal(allowed.success, true);
});

test("the injected session fixes the recipient; the model cannot switch to another allowed chat", async () => {
  const seen: any[] = [];
  const service = createService(config, {
    submit: async (event) => {
      seen.push(event);
      return { event: 1, duplicate: false, routed: ["QQ 任务"], paused: [] };
    },
    outcome: async () => ({ runs: [] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({}),
  });
  assert.deepEqual(
    await service.handle(
      { action: "submit", project: "shop", text: "x", target_session: "private:1991849113" },
      { sender_id: "1991849113", session_id: "group:742118793" },
    ),
    { success: false, error: "目标会话与本轮来源会话不一致" },
  );
  assert.equal(seen.length, 0);
  const result: any = await service.handle(
    { action: "submit", project: "shop", text: "x", target_session: "group:742118793" },
    { sender_id: "1991849113", session_id: "group:742118793" },
  );
  assert.equal(result.success, true);
  assert.equal(seen[0].subject, "qq-group-742118793/shop");
});

test("model parameters cannot forge the sender identity", async () => {
  const seen: any[] = [];
  const service = createService(config, {
    submit: async (event) => {
      seen.push(event);
      return { event: 1, duplicate: false, routed: ["QQ 任务"], paused: [] };
    },
    outcome: async () => ({ runs: [] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({}),
  });
  assert.deepEqual(
    await service.handle({
      action: "submit",
      project: "shop",
      text: "x",
      target_session: "group:742118793",
      sender_id: "1991849113",
    }),
    { success: false, error: "群聊请求缺少可信发送人身份，已拒绝" },
  );
  const accepted: any = await service.handle(
    {
      action: "submit",
      project: "shop",
      text: "x",
      target_session: "group:742118793",
      sender_id: "1991849113",
    },
    { sender_id: "12345" },
  );
  assert.equal(accepted.success, false);
  const result: any = await service.handle(
    {
      action: "submit",
      project: "shop",
      text: "x",
      target_session: "group:742118793",
      sender_id: "1991849113",
      session_id: "private:1991849113",
    },
    { sender_id: "1991849113", session_id: "group:742118793" },
  );
  assert.equal(result.success, true);
  assert.equal(seen[0].actor, "1991849113");
  const nested = await service.handle(
    {
      action: "submit",
      project: "shop",
      text: "x",
      target_session: "group:742118793",
      context: { sender_id: "1991849113" },
    },
    { sender_id: "12345" },
  );
  assert.deepEqual(nested, { success: false, error: "这个发送人没有派任务权限" });
});

test("each project and conversation gets its own lane; the reply stays with the conversation", () => {
  const shop = eventOf("group:742118793", "shop", "修一下结算页", config.allow.actor, "fixed");
  const site = eventOf("group:742118793", "site", "首页慢了", config.allow.actor, "fixed");
  assert.equal(shop.subject, "qq-group-742118793/shop");
  assert.equal(site.subject, "qq-group-742118793/site");
  assert.notEqual(laneOf("group:742118793", "shop"), laneOf("group:742118793", "site"));
  assert.equal(shop.reply, "qq-group-742118793");
  assert.equal(shop.actor, "1991849113");
  assert.equal(eventOf("private:1991849113", "shop", "hi", config.allow.actor).reply, "qq-private-1991849113");
  assert.match(shop.id, /^insoulforge:/);
});

test("instructions tell the model where the session comes from and what it may not change", () => {
  const text = instructions(config);
  assert.match(text, /current_session/);
  assert.match(text, /group:<群号>/);
  assert.match(text, /- shop：商城/);
  assert.match(text, /天气、资料、新闻/);
  assert.match(text, /必须选 general/);
  assert.match(text, /禁止默认选列表里的第一个项目/);
  assert.match(text, /不是文件路径/);
});

test("a general task is acknowledged as a general task, not as a code project", async () => {
  const service = createService(config, {
    submit: async () => ({ event: 3, duplicate: false, routed: ["QQ 通用任务"], paused: [] }),
    outcome: async () => ({ runs: [{ run: 43, state: "queued", summary: "明天上海天气" }] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({}),
  });
  const result: any = await service.handle(
    { action: "submit", project: "general", text: "明天上海天气怎么样", target_session: "group:742118793" },
    { sender_id: "1991849113" },
  );
  assert.equal(result.success, true);
  assert.equal(result.result.project, "general");
  assert.equal(result.result.accepted, true);
  assert.match(result.result.ack, /已派单给 Agent Autoloop（通用任务，任务 #43）/);
  assert.doesNotMatch(result.result.ack, /项目：general/);
});

test("status requires the same trusted operator identity as submit and answer", async () => {
  const service = createService(config, {
    submit: async () => ({}),
    outcome: async () => ({ runs: [] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({}),
  });
  assert.deepEqual(await service.handle({ action: "status" }), {
    success: false,
    error: "群聊请求缺少可信发送人身份，已拒绝",
  });
  assert.deepEqual(await service.handle({ action: "status" }, { sender_id: "12345" }), {
    success: false,
    error: "这个发送人没有查看进度的权限",
  });
  const allowed: any = await service.handle({ action: "status" }, { sender_id: "1991849113" });
  assert.equal(allowed.success, true);
});

test("status only reports the allowed chats, and a project narrows it further", () => {
  const state = {
    cards: [
      { id: 1, lane: "qq-group-742118793/shop", title: "改哪里", text: "x", options: ["a", "b"] },
      { id: 2, lane: "qq-group-999/shop", title: "别人的", text: "y", options: [] },
      { id: 3, lane: "qq-private-1991849113/site", title: "私聊", text: "z", options: ["a", "b"] },
    ],
    runs: [
      { id: 10, lane: "qq-group-742118793/shop", state: "claimed", summary: "在改", createdAt: "t" },
      { id: 11, lane: "qq-group-742118793/site", state: "queued", summary: "排队", createdAt: "t" },
      { id: 12, lane: "qq-group-999/shop", state: "done", summary: "别人", createdAt: "t" },
      { id: 13, lane: "qq-group-742118793/shop", state: "failed", summary: "", error: "炸了", createdAt: "t" },
    ],
  };
  const all = statusOf(state, config) as any;
  assert.deepEqual(
    all.result.cards.map((card: any) => card.card),
    [1, 3],
  );
  assert.equal(all.result.counts.running, 1);
  assert.equal(all.result.counts.queued, 1);
  assert.equal(all.result.counts.waiting, 2);
  assert.ok(all.result.summary.includes("炸了"));
  const shop = statusOf(state, config, "group:742118793", "shop") as any;
  assert.deepEqual(
    shop.result.cards.map((card: any) => card.card),
    [1],
  );
  assert.deepEqual(
    shop.result.runs.map((run: any) => run.run),
    [10, 13],
  );
});

test("a submit posts one event with the source key's shape and its project lane", async () => {
  const seen: any[] = [];
  const service = createService(config, {
    submit: async (event) => {
      seen.push(event);
      return { event: 1, duplicate: false, routed: ["QQ 任务"], paused: [] };
    },
    outcome: async () => ({ runs: [{ run: 42, state: "queued", summary: "修一下结算页" }] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({ changed: true }),
  });
  const result: any = await service.handle(
    { action: "submit", project: "shop", text: "修一下结算页", target_session: "group:742118793" },
    { sender_id: "1991849113" },
  );
  assert.equal(result.success, true);
  assert.equal(result.result.routed[0], "QQ 任务");
  assert.equal(result.result.run, 42);
  assert.match(result.result.ack, /已派单给 Agent Autoloop（项目：shop，任务 #42）/);
  assert.match(result.result.ack, /修一下结算页/);
  assert.deepEqual(seen[0], {
    id: seen[0].id,
    type: "qq.task",
    subject: "qq-group-742118793/shop",
    summary: "修一下结算页",
    detail: "修一下结算页",
    actor: "1991849113",
    reply: "qq-group-742118793",
  });
  assert.deepEqual(
    await service.handle({ action: "submit", project: "../etc", text: "x", target_session: "group:742118793" }),
    { success: false, error: "project 不在允许的项目里" },
  );
  assert.deepEqual(
    await service.handle({ action: "submit", project: "shop", text: "x", target_session: "group:999" }),
    { success: false, error: "这个会话不在允许范围内" },
  );
});

test("a group member who is not on the sender allowlist cannot submit", async () => {
  const service = createService(config, {
    submit: async () => ({ routed: ["QQ 任务"] }),
    outcome: async () => ({ runs: [] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({}),
  });
  assert.deepEqual(
    await service.handle(
      { action: "submit", project: "shop", text: "x", target_session: "group:742118793" },
      { sender_id: "12345" },
    ),
    { success: false, error: "这个发送人没有派任务权限" },
  );
  assert.deepEqual(
    await service.handle(
      { action: "submit", project: "shop", text: "x", target_session: "group:742118793" },
      undefined,
    ),
    { success: false, error: "群聊请求缺少可信发送人身份，已拒绝" },
  );
  let submitted = false;
  const answerHub = {
    submit: async () => {
      submitted = true;
      return {};
    },
    outcome: async () => ({ runs: [] }),
    state: async () => ({
      cards: [{ id: 7, lane: "qq-group-742118793/shop", title: "选", text: "x", options: ["甲", "乙"] }],
      runs: [],
    }),
    answer: async () => ({ changed: true, state: "decided" }),
  };
  const answerService = createService(config, answerHub);
  assert.deepEqual(
    await answerService.handle(
      { action: "answer", card: 7, choice: 1, target_session: "group:742118793" },
      { sender_id: "12345" },
    ),
    { success: false, error: "这个发送人没有回答权限" },
  );
  assert.equal(submitted, false);
});

test("a submit the hub accepted but no rule took still returns an honest acknowledgement", async () => {
  const service = createService(config, {
    submit: async () => ({ event: 2, duplicate: false, routed: [], paused: [] }),
    outcome: async () => ({ runs: [] }),
    state: async () => ({ cards: [], runs: [] }),
    answer: async () => ({}),
  });
  const result: any = await service.handle({
    action: "submit",
    project: "site",
    text: "检查首页",
    target_session: "private:1991849113",
  }, { sender_id: "1991849113" });
  assert.equal(result.success, true);
  assert.equal(result.result.accepted, false);
  assert.match(result.result.ack, /没有规则接单/);
  assert.match(result.result.ack, /检查首页/);
});

test("an answer is only accepted for an open card in that conversation, and choice is made one-based", async () => {
  const answered: any[] = [];
  const service = createService(config, {
    submit: async () => ({}),
    outcome: async () => ({ runs: [] }),
    state: async () => ({
      cards: [
        { id: 7, lane: "qq-group-742118793/shop", title: "选", text: "x", options: ["甲", "乙"] },
        { id: 8, lane: "qq-private-1991849113/shop", title: "私", text: "x", options: ["甲", "乙"] },
      ],
      runs: [],
    }),
    answer: async (card, body) => {
      answered.push({ card, body });
      return { changed: true, state: "decided" };
    },
  });
  const ok: any = await service.handle(
    { action: "answer", card: 7, choice: 2, target_session: "group:742118793" },
    { sender_id: "1991849113" },
  );
  assert.deepEqual(ok, { success: true, result: { answered: true, card: 7, state: "decided" } });
  assert.deepEqual(answered, [{ card: 7, body: { choice: 1 } }]);
  assert.deepEqual(
    await service.handle(
      { action: "answer", card: 7, choice: 1, target_session: "private:1991849113" },
      { sender_id: "1991849113" },
    ),
    { success: false, error: "这不是当前会话里等待回答的卡片；先用 status 确认" },
  );
  assert.deepEqual(
    await service.handle(
      { action: "answer", card: 7, choice: 1, target_session: "private:1991849113" },
      { sender_id: "12345" },
    ),
    { success: false, error: "调用方身份与会话不一致" },
  );
  assert.deepEqual(
    await service.handle(
      { action: "answer", card: 7, choice: 3, target_session: "group:742118793" },
      { sender_id: "1991849113" },
    ),
    { success: false, error: "choice 要在 1 到 2 之间" },
  );
  assert.deepEqual(
    await service.handle({ action: "answer", card: 7, target_session: "group:742118793" }, { sender_id: "1991849113" }),
    { success: false, error: "回答要么给 choice，要么给 text，只能选一种" },
  );
});

test("a hub refusal becomes a normal failed response rather than an exception", async () => {
  const service = createService(config, {
    submit: async () => {
      throw new Error("中台返回 401：要来源自己的密钥");
    },
    outcome: async () => ({ runs: [] }),
    state: async () => {
      throw new Error("连不上");
    },
    answer: async () => ({}),
  });
  assert.deepEqual(
    await service.handle(
      { action: "submit", project: "shop", text: "x", target_session: "group:742118793" },
      { sender_id: "1991849113" },
    ),
    { success: false, error: "任务没有交上：中台返回 401：要来源自己的密钥" },
  );
  assert.deepEqual(await service.handle({ action: "status" }, { sender_id: "1991849113" }), {
    success: false,
    error: "查不到进度：连不上",
  });
  assert.deepEqual(await service.handle({ action: "nope" }), {
    success: false,
    error: "action 只能是 submit、status、answer、projects",
  });
});

test("the WebSocket handshake sends the Authorization header and a frame exchange survives it", async () => {
  const seen: Record<string, any> = {};
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    seen.authorization = request.headers.authorization;
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (data) => {
      const opcode = data[0]! & 15;
      if (opcode === 8) return socket.end();
      const length = data[1]! & 127;
      const mask = data.subarray(2, 6);
      const body = Buffer.from(data.subarray(6, 6 + length));
      for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4]!;
      seen.received = body.toString();
      const reply = Buffer.from(JSON.stringify({ type: "ready" }));
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = await open(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/activities/ws`, {
    authorization: "Bearer secret",
  });
  const ready = new Promise<any>((resolve) => (socket.onmessage = (data) => resolve(JSON.parse(data))));
  socket.send(JSON.stringify({ type: "register", name: "x" }));
  assert.deepEqual(await ready, { type: "ready" });
  assert.equal(seen.authorization, "Bearer secret");
  assert.match(seen.received, /"type":"register"/);
  socket.close();
  server.closeAllConnections();
  server.close();
});

test("a local close settles the Activity wait, so a lost handshake reconnects instead of exiting the process", async () => {
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // No `ready`: the Activity is still waiting to register when the server goes away.
    socket.on("data", () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/activities/ws`;
  const stop = new AbortController();
  const lines: string[] = [];
  const running = serve(
    { ...config, activity: { ...config.activity, url } },
    createService(config, {
      submit: async () => ({}),
      outcome: async () => ({ runs: [] }),
      state: async () => ({ cards: [], runs: [] }),
      answer: async () => ({}),
    }),
    (line) => lines.push(line),
    stop.signal,
  );
  const deadline = Date.now() + 3_000;
  while (!lines.some((line) => line.includes("秒后重连")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    lines.some((line) => line.includes("秒后重连")),
    lines.join("\n"),
  );
  stop.abort();
  await running;
  server.closeAllConnections();
  server.close();
});

after(() => {});

test("serve registers, answers, and notices a closed socket", async () => {
  const returned: any[] = [];
  const server = createServer();
  let frame: Buffer = Buffer.alloc(0);
  const received: any[] = [];
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (data) => {
      frame = Buffer.concat([frame, data]);
      for (;;) {
        if (frame.length < 2) return;
        const opcode = frame[0]! & 15;
        const masked = Boolean(frame[1]! & 0x80);
        let length = frame[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (frame.length < 4) return;
          length = frame.readUInt16BE(2);
          offset = 4;
        }
        const maskAt = offset;
        if (masked) offset += 4;
        if (frame.length < offset + length) return;
        const body = Buffer.from(frame.subarray(offset, offset + length));
        if (masked) {
          const mask = frame.subarray(maskAt, maskAt + 4);
          for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4]!;
        }
        frame = frame.subarray(offset + length);
        if (opcode === 8) {
          socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
          socket.end();
          return;
        }
        if (opcode !== 1) continue;
        const message = JSON.parse(body.toString());
        received.push(message);
        if (message.type === "register") {
          socket.write(serverFrame({ type: "ready" }));
          socket.write(
            serverFrame({
              type: "request",
              parameters: { action: "submit", project: "shop", text: "修一下", target_session: "group:742118793" },
              context: { sender_id: "1991849113" },
            }),
          );
        } else if (message.type === "response") returned.push(message);
      }
    });
  });
  function serverFrame(value: unknown) {
    const payload = Buffer.from(JSON.stringify(value));
    const header =
      payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
    return Buffer.concat([header, payload]);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/activities/ws`;
  const service = createService(
    { ...config, activity: { ...config.activity, url } },
    {
      submit: async () => ({ routed: ["QQ 任务"] }),
      outcome: async () => ({ runs: [] }),
      state: async () => ({ cards: [], runs: [] }),
      answer: async () => ({}),
    },
  );
  const stop = new AbortController();
  const running = serve({ ...config, activity: { ...config.activity, url } }, service, () => {}, stop.signal);
  const deadline = Date.now() + 5_000;
  while (!returned.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received[0]?.type, "register");
  assert.equal(returned[0]?.type, "response");
  assert.equal(returned[0]?.success, true);
  stop.abort();
  await running;
  server.closeAllConnections();
  server.close();
});
