// Failure cases: a group message, the bot's own echo, an unlisted sender, a bare `#N` card answer, or an empty message
// becomes a task; the same OneBot message is dispatched twice after a reconnect; a task carries words where an identity
// belongs; the bridge can't reach the hub and loses the message without saying so.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { taskOf, wordsOf, createBridge } from "../plugins/qq-source/bridge.ts";

const stops: AbortController[] = [];
after(() => stops.forEach((stop) => stop.abort()));

const onebot = (payload: object) => ({
  post_type: "message",
  message_type: "private",
  self_id: 1517455220,
  user_id: 10001,
  message_id: 9001,
  raw_message: "整理一下今天的日志",
  message: [{ type: "text", data: { text: "整理一下今天的日志" } }],
  ...payload,
});

const options = { allowed: ["10001"], bot: "1517455220" };

test("qq-source: a private message from an allowed person becomes one task with the sender as actor", () => {
  const task = taskOf(onebot({}), options);
  assert.deepEqual(task, {
    id: "qq:9001",
    type: "qq.task",
    subject: "qq-private-10001",
    summary: "整理一下今天的日志",
    detail: "整理一下今天的日志",
    actor: "10001",
    link: "",
    reply: "qq-private-10001",
  });
});

test("qq-source: a group message from an allowed sender becomes a task in that group", () => {
  const group = { ...options, groups: ["20002"] };
  assert.deepEqual(taskOf(onebot({ message_type: "group", group_id: 20002 }), group), {
    id: "qq:9001",
    type: "qq.task",
    subject: "qq-group-20002",
    summary: "整理一下今天的日志",
    detail: "整理一下今天的日志",
    actor: "10001",
    link: "",
    reply: "qq-group-20002",
  });
  assert.equal(taskOf(onebot({ message_type: "group", group_id: 20003 }), group), null, "another group is not a task");
  assert.equal(taskOf(onebot({ message_type: "group", group_id: 20002 }), options), null, "no groups, no group tasks");
  assert.equal(
    taskOf(onebot({ message_type: "group", group_id: 20002, user_id: 20002 }), group),
    null,
    "a group message from someone off the allowlist is ignored",
  );
});

test("qq-source: only private text from an allowed sender is a task", () => {
  assert.equal(taskOf(onebot({ message_type: "group", group_id: 1 }), options), null);
  assert.equal(taskOf(onebot({ user_id: 20002 }), options), null);
  assert.equal(taskOf(onebot({ self_id: 10001 }), options), null, "the bot's own message");
  assert.equal(
    taskOf(onebot({ self_id: 30003, user_id: 1517455220 }), options),
    null,
    "the bot's configured number is refused even when OneBot reports another self_id",
  );
  assert.equal(taskOf(onebot({ message: [], raw_message: "" }), options), null);
  assert.equal(taskOf(onebot({ message: "#2", raw_message: "#2" }), options), null, "a card answer is not a task");
  assert.equal(taskOf(onebot({ message: [{ type: "image", data: { file: "x" } }], raw_message: "" }), options), null);
});

test("qq-source: an allowlist is required, and a missing list admits nobody", () => {
  assert.equal(taskOf(onebot({}), { bot: "1517455220" } as any), null);
  assert.equal(taskOf(onebot({}), { allowed: [], bot: "1517455220" }), null);
});

test("qq-source: words are trimmed and cut to the event limits", () => {
  assert.deepEqual(wordsOf([{ type: "text", data: { text: "  你好  " } }], "raw"), { text: "  你好  ", reply: "" });
  assert.deepEqual(wordsOf(undefined, "[CQ:reply,id=7] 你好"), { text: " 你好", reply: "7" });
  assert.deepEqual(
    wordsOf(
      [
        { type: "reply", data: { id: "7" } },
        { type: "text", data: { text: "你好" } },
      ],
      "",
    ),
    { text: "你好", reply: "7" },
  );
  const long = taskOf(onebot({ message: [{ type: "text", data: { text: "x".repeat(5000) } }] }), options)!;
  assert.equal(long.summary.length, 200);
  assert.equal(long.detail.length, 4000);
});

test("qq-source: the bridge posts once, keeps dedupe across reconnects, and never answers a card with a task", async () => {
  const posted: any[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    posted.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ event: posted.length, duplicate: false, routed: ["处理"], paused: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = new AbortController();
  stops.push(stop);
  const seen: string[] = [];
  const bridge = createBridge({
    url,
    key: "source-key",
    options,
    log: (line) => seen.push(line),
    signal: stop.signal,
  });
  assert.equal(await bridge.accept(onebot({})), true);
  assert.equal(await bridge.accept(onebot({})), false, "the same OneBot message isn't dispatched twice");
  assert.equal(await bridge.accept(onebot({ message_id: 9002, message: "#1", raw_message: "#1" })), false);
  assert.equal(await bridge.accept(onebot({ message_id: 9003, message_type: "group", group_id: 1 })), false);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "/v1/events");
  assert.equal(posted[0].headers.authorization, "Bearer source-key");
  assert.equal(posted[0].body.type, "qq.task");
  stop.abort();
  server.close();
});

test("qq-source: a leading /topic puts a task on its own subject and out of the words", () => {
  const group = { ...options, groups: ["20002"] };
  const task = taskOf(
    onebot({
      message_type: "group",
      group_id: 20002,
      message: [{ type: "text", data: { text: "/shop  修一下结算页  " } }],
    }),
    group,
  )!;
  assert.equal(task.subject, "qq-group-20002/shop");
  assert.equal(task.detail, "修一下结算页  ");
  assert.equal(task.reply, "qq-group-20002", "the answer still goes to the whole conversation");
  const plain = taskOf(onebot({ message: [{ type: "text", data: { text: "随便说说" } }] }), options)!;
  assert.equal(plain.subject, "qq-private-10001", "a message without a topic keeps the plain conversation");
  const bare = taskOf(
    onebot({ message_type: "group", group_id: 20002, message: [{ type: "text", data: { text: "/shop" } }] }),
    group,
  )!;
  assert.equal(bare.subject, "qq-group-20002", "a lone slash word is ordinary text, not an empty topic");
});
