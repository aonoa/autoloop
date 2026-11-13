// Failure modes: a chat channel gets the long review-style prompt and floods the chat; an async channel is told to be
// terse; a speculative round delivers a card when it found nothing; a speculative round that found something never hands
// the work to a real round.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { promptFor } from "../worker/contract.ts";
import type { Job } from "../protocol/job.ts";

const base = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
const env = { secret: "style", publicUrl: "https://hub.test" };

test("an im channel tells the agent to keep it short", () => {
  const rules = parseRules(
    JSON.stringify({
      ...base,
      channels: { chat: { name: "聊天", style: "im" } },
      defaultChannels: ["chat"],
    }),
    0,
    "UTC",
  );
  const job = {
    run: 1,
    token: "t",
    attempt: 1,
    rule: { name: "意见", cwd: "~/x", prompt: "做。" },
    style: "im",
    agent: { id: "a1", name: "甲", use: "command", access: "read" },
    session: null,
    askFirst: [],
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  } as unknown as Job;
  const text = promptFor(job, "/tmp/c.json");
  assert.match(text, /不超过 100 词/);
  assert.ok(!text.includes("分小节写清楚"));
});

test("an async channel asks for a full write-up", () => {
  const job = {
    run: 1,
    token: "t",
    attempt: 1,
    rule: { name: "意见", cwd: "~/x", prompt: "做。" },
    style: "async",
    agent: { id: "a1", name: "甲", use: "command", access: "read" },
    session: null,
    askFirst: [],
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  } as unknown as Job;
  const text = promptFor(job, "/tmp/c.json");
  assert.match(text, /分小节写清楚/);
  assert.ok(!text.includes("不超过 100 词"));
});

function hub(extra: object = {}) {
  const rules = parseRules(JSON.stringify({ ...base, ...extra }), 0, "UTC");
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, env);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  let events = 0;
  const send = () => act("ingest", "app", { id: `e${++events}`, type: "feedback.new", subject: "#1", actor: "alice" });
  const claim = () => act("claimNext", "w1", `c${++events}`);
  return { act, send, claim, view: () => view };
}

test("a speculative rule starts a background round, not a delivered one", () => {
  const h = hub({
    rules: base.rules.map((rule: any) => (rule.name === "意见" ? { ...rule, speculate: true } : rule)),
  });
  const ack = h.send();
  const [run] = rows(h.view(), "runs");
  assert.equal(run.kind, "speculate");
  assert.deepEqual(ack.routed, [], "a try in the background has not taken the event for its rule");
  const [event] = rows(h.view(), "events");
  assert.deepEqual(JSON.parse(event.routed), []);
  assert.deepEqual(JSON.parse(event.dispatched), []);
});

test("a speculative round that found nothing delivers no card and no follow-up round", () => {
  const h = hub({
    rules: base.rules.map((rule: any) => (rule.name === "意见" ? { ...rule, speculate: true } : rule)),
  });
  h.send();
  const job = h.claim();
  h.act("finish", job.run, job.token, {
    outcome: "nothing",
    summary: "群里只是闲聊",
    report: { state: "dropped" },
  });
  assert.equal(rows(h.view(), "cards").length, 0);
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
});

test("a speculative round that blocked or failed hands over nothing", () => {
  for (const report of [{ state: "blocked" }, { state: "failed" }]) {
    const h = hub({
      rules: base.rules.map((rule: any) => (rule.name === "意见" ? { ...rule, speculate: true } : rule)),
    });
    h.send();
    const job = h.claim();
    h.act("finish", job.run, job.token, { outcome: "done", report });
    assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0, report.state);
  }
});

test("a speculative round worth delivering hands the work to a real round", () => {
  const h = hub({
    rules: base.rules.map((rule: any) => (rule.name === "意见" ? { ...rule, speculate: true } : rule)),
  });
  h.send();
  const job = h.claim();
  h.act("finish", job.run, job.token, {
    outcome: "done",
    summary: "复现了，是个小 bug",
    report: { state: "ready" },
  });
  const queued = rows(h.view(), "runs", { state: "queued" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, undefined, "the real round is not speculative");
  assert.equal(queued[0].rule, "意见");
});

test("the prompt tells a speculative round to stay quiet when it finds nothing", () => {
  const job = {
    run: 1,
    token: "t",
    attempt: 1,
    kind: "speculate",
    rule: { name: "意见", cwd: "~/x", prompt: "做。" },
    agent: { id: "a1", name: "甲", use: "command", access: "read" },
    session: null,
    askFirst: [],
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  } as unknown as Job;
  const text = promptFor(job, "/tmp/c.json");
  assert.match(text, /后台预演/);
  assert.match(text, /"state":"dropped"/);
});

test("a round is told which matter it belongs to and what came before", () => {
  const h = hub();
  h.send();
  const first = h.claim();
  h.act("finish", first.run, first.token, { outcome: "done", summary: "第一轮做完了" });
  h.send();
  const job = h.claim();
  assert.equal(job.thread?.id, "意见:#1");
  assert.equal(job.thread?.rule, "意见");
  assert.equal(job.thread?.lane, "#1");
  assert.ok(
    job.thread?.rounds.some(
      (round: { run: number; summary: string }) => round.run === first.run && round.summary === "第一轮做完了",
    ),
    "past rounds are named, not expanded",
  );
});

test("the prompt names the matter and points at past rounds by number", () => {
  const job = {
    run: 9,
    token: "t",
    attempt: 1,
    rule: { name: "意见", cwd: "~/x", prompt: "做。" },
    agent: { id: "a1", name: "甲", use: "command", access: "read" },
    session: null,
    askFirst: [],
    thread: {
      id: "意见:#1",
      rule: "意见",
      lane: "#1",
      rounds: [
        { run: 7, state: "done", summary: "查过了", at: "2026-11-05T00:00:00.000Z" },
        { run: 9, state: "queued", summary: "", at: null },
      ],
      related: [{ rule: "告警", lane: "#1", stage: "working" }],
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  } as unknown as Job;
  const text = promptFor(job, "/tmp/c.json");
  assert.match(text, /这件事是 意见:#1/);
  assert.match(text, /第 7 轮 done：查过了/);
  assert.match(text, /agent-autoloop why <第几轮>/);
  assert.match(text, /同一对象上还有别的事在做：告警\/#1（working）/);
  assert.ok(!text.includes("第 9 轮"), "the current round is not listed as past");
});
