// Failure modes: a matter waiting on a person is shown as working; an automatic input wakes a blocked matter without a
// person; a person's answer doesn't release it; a ready report isn't shown for review; a round still in progress is shown
// as idle; a delivered card answer is counted as an automatic input. The stage table is read top to bottom, first match
// wins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { stagesOf, stageOf } from "../kernel/stage.ts";
import { parseRules } from "../protocol/rules.ts";

const base = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
const env = { secret: "stage", publicUrl: "https://hub.test" };
const rules = parseRules(JSON.stringify(base), 0, "UTC");

function hub() {
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, env);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  let events = 0;
  const send = (event: object = {}) =>
    act("ingest", "app", { id: `e${++events}`, type: "feedback.new", subject: "#1", actor: "alice", ...event });
  const claim = () => act("claimNext", "w1", `c${++events}`);
  const finish = (job: any, result: object) => act("finish", job.run, job.token, { outcome: "done", ...result });
  const stage = (lane = "#1") => stageOf(view, rules, "意见", lane, now);
  return { act, send, claim, finish, stage, view: () => view, now: () => now };
}

test("a matter with no round yet is queued, and one with a claim is working", () => {
  const h = hub();
  assert.equal(h.stage(), "working/queued");
  h.send();
  assert.equal(h.stage(), "working/queued");
  h.claim();
  assert.equal(h.stage(), "working");
});

test("a waiting report is idle, and a ready one waits for review", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { report: { state: "waiting" } });
  assert.equal(h.stage(), "idle");
  h.send();
  const second = h.claim();
  h.finish(second, { report: { state: "ready", note: "改好了" } });
  assert.equal(h.stage(), "person/review");
});

test("a progress report is still working, not idle", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { report: { state: "progress", note: "还在跑测试" } });
  assert.equal(h.stage(), "working");
});

test("an open question is a person's, and outranks a report", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, {
    ask: [{ title: "怎么发货", text: "两种都行", options: ["快递", "自提"] }],
    report: { state: "ready" },
  });
  assert.equal(h.stage(), "person/answer");
});

test("a blocked matter takes no automatic input, and a person's answer releases it", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { report: { state: "blocked", note: "等账号权限" } });
  assert.equal(h.stage(), "person/blocked");
  // A new automatic event is recorded but not queued.
  h.send();
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
  assert.equal(h.stage(), "person/blocked");
  // The owner asking for it by hand goes through, and the matter moves on.
  h.act("runRule", "意见", "me", { subject: "#1", reason: "我来看" });
  assert.ok(rows(h.view(), "runs", { state: "queued" }).length > 0);
  assert.notEqual(h.stage(), "person/blocked");
});

test("a person's resolve releases a blocked matter without starting a round by itself", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { report: { state: "blocked", note: "等账号权限" } });
  assert.equal(h.stage(), "person/blocked");
  const card = h.act("createCard", {
    key: "blocked-1",
    kind: "notice",
    title: "账号还没通",
    text: "先放一放",
    rule: "意见",
    lane: "#1",
  });
  const runsBefore = rows(h.view(), "runs").length;
  assert.equal(h.act("resolve", card.card, "不用了，先放着", "本人"), true);
  assert.equal(rows(h.view(), "runs").length, runsBefore, "closing a card starts nothing");
  assert.notEqual(h.stage(), "person/blocked");
  h.send();
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 1, "the next automatic event may start work again");
});

test("a failed matter waits for a person too", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { report: { state: "failed", note: "构建挂了" } });
  assert.equal(h.stage(), "person/failed");
  h.send();
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
});

test("a delivered card answer is a person's input, not an automatic one", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, {
    ask: [{ title: "继续吗", text: "改动挺大", options: ["继续", "停"] }],
    report: { state: "blocked" },
  });
  const [card] = rows(h.view(), "cards", { state: "open" });
  h.act("answer", card.id, { choice: 0, by: "me" });
  assert.ok(rows(h.view(), "runs", { state: "queued" }).length > 0, "the answer wakes it");
});

test("a card whose latest send failed and is waiting to retry is a delivery problem", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { notice: [{ title: "更新", text: "改动挺大" }] });
  const card = rows(h.view(), "cards", { state: "open" })[0];
  const first = h.act("nextCard", "chat");
  assert.equal(first.id, card.id);
  h.act("failed", "chat", card.id, first.version, "飞书挂了");
  assert.equal(h.stage(), "person/delivery");
  // An old failure, or one the channel has given up on, is not what the matter waits for.
  h.act("nextCard", "chat");
  h.act("delivered", "chat", card.id, first.version, "om_1");
  assert.equal(h.stage(), "idle");
});

test("a question that could not be delivered is shown as delivery, before waiting for an answer", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { ask: [{ title: "继续吗", text: "改动挺大", options: ["继续", "停"] }] });
  const card = rows(h.view(), "cards", { state: "open" })[0];
  const first = h.act("nextCard", "chat");
  h.act("failed", "chat", card.id, first.version, "飞书挂了");
  assert.equal(h.stage(), "person/delivery");
});

test("an automatic event after a blocked report does not count as a person releasing it", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { report: { state: "blocked", note: "等账号权限" } });
  h.send();
  assert.equal(h.stage(), "person/blocked");
});

test("the board lists live matters, not every matter ever seen", () => {
  const h = hub();
  h.send({ subject: "#1" });
  const first = h.claim();
  h.finish(first, { outcome: "nothing", report: { state: "waiting" } });
  h.send({ subject: "#2" });
  const second = h.claim();
  h.finish(second, { report: { state: "ready" } });
  assert.deepEqual(
    stagesOf(h.view(), rules, h.now()).map((matter) => [matter.lane, matter.stage]),
    [["#2", "person/review"]],
    "a waiting matter with nothing queued is not the board's work",
  );
});

test("a round closing another lane's card is not a person releasing that matter", () => {
  const h = hub();
  const question = { ask: [{ title: "用哪个账号", text: "两个都能登录", options: ["甲", "乙"] }] };
  h.send({ subject: "#1" });
  const first = h.claim();
  h.finish(first, { ...question, report: { state: "blocked", note: "等账号权限" } });
  h.send({ subject: "#2" });
  const other = h.claim();
  h.finish(other, { ...question, report: { state: "blocked", note: "等账号权限" } });
  const [, second] = rows(h.view(), "cards", { state: "open" });
  // A round of the same group and source may close either lane's card; its `by` names a round, not a person.
  h.act("runRule", "意见", "me", { subject: "#1", reason: "我来看" });
  const resolving = h.claim();
  h.finish(resolving, {
    resolve: [{ card: second.id, reason: "问错了，先不用" }],
    report: { state: "blocked", note: "等账号权限" },
  });
  assert.equal(h.stage("#2"), "person/blocked");
  h.send({ subject: "#2" });
  assert.equal(rows(h.view(), "runs", { rule: "意见", lane: "#2", state: "queued" }).length, 0);
});

test("a closed card's failed delivery no longer makes the matter wait for delivery", () => {
  const h = hub();
  h.send();
  const job = h.claim();
  h.finish(job, { ask: [{ title: "继续吗", text: "改动挺大", options: ["继续", "停"] }] });
  const card = rows(h.view(), "cards", { state: "open" })[0];
  const first = h.act("nextCard", "chat");
  h.act("failed", "chat", card.id, first.version, "飞书挂了");
  h.act("resolve", card.id, "我自己决定", "本人");
  assert.notEqual(h.stage(), "person/delivery");
});
