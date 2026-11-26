// Failure cases: an event with no project hint never reaches the dispatcher; a queued dispatch looks like "no rule took it";
// a dispatch card cannot answer back where the event came from; placing an event reuses the conversation-only lane and two
// projects share history; a dispatcher cannot reply to a non-task, or its reply starts work; a placed event leaves no audit
// record or no notice saying where it went; a failed dispatch is relabelled unassigned, hiding that the round itself broke;
// a non-fyi notice is sent straight to a person as if it were a chat reply.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { eventOutcome, unrouted } from "../kernel/query.ts";
import { parseRules } from "../protocol/rules.ts";

const base = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));

function hub(extra: object = {}) {
  const rules = parseRules(JSON.stringify({ ...base, ...extra }), 0, "UTC");
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, { secret: "dispatch", publicUrl: "https://hub.test" });
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  let events = 0;
  const send = (event: object = {}, source = "app") =>
    act("ingest", source, { id: `e${++events}`, type: "qq.task", ...event });
  return { act, send, view: () => view, log };
}

const project = (name: string, cwd: string, agent: string, subjects: string[], description?: string) => ({
  name: `QQ 任务 ${name}`,
  when: { source: "app", types: ["qq.task"], subjects },
  to: agent,
  cwd,
  group: name,
  prompt: `处理 ${name}。`,
  project: name,
  ...(description && { description }),
  resume: true,
});

const routing = (extra: object = {}) => ({
  ...base,
  sources: { ...base.sources, app: { name: "应用", policy: { allowlist: ["alice"] } } },
  agents: {
    ...base.agents,
    a1: { ...base.agents.a1, worker: "w1" },
    a2: { ...base.agents.a2, worker: "w2" },
    a4: { ...base.agents.a1, name: "调度", worker: "w1" },
  },
  rules: [
    project("mini", "~/mini", "a1", ["/mini"], "迷你项目"),
    project("shop", "~/shop", "a2", ["/shop"], "商城项目"),
  ],
  policy: { accept: "gate", dispatch: { agent: "a4", minConfidence: 0.7 } },
  ...extra,
});

test("a task without a project hint is recorded as waiting for the dispatcher, not as unrouted", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "qq-private-10001", actor: "alice", summary: "查一下天气" });
  assert.deepEqual(ack.routed, []);
  assert.equal(ack.pending, true);
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.equal(event.dispatch_state, "queued");
  assert.ok(event.dispatch_run);
  assert.equal(unrouted(h.view()).length, 0);
  assert.equal(eventOutcome(h.view(), "app", ack.event)!.pending, true);
});

test("a dispatcher can reply directly without starting a project round", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({
    subject: "qq-private-10001",
    actor: "alice",
    summary: "在吗",
    reply: "qq-private-10001",
  });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    notice: [{ title: "直接回复", text: "在，直接说就行。", fyi: true }],
  });
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.equal(event.dispatch_state, "replied");
  assert.equal(rows(h.view(), "runs", { rule: "QQ 任务 mini", state: "queued" }).length, 0);
  const card = rows(h.view(), "cards", { title: "直接回复" }).at(-1)!;
  assert.equal(card.fyi, 1);
  assert.equal(card.reply, "qq-private-10001");
  assert.equal(eventOutcome(h.view(), "app", ack.event)!.runs.length, 1, "the reply round remains the only run");
});

test("a notice without fyi is not a direct reply to the person", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "qq-private-10001", actor: "alice", summary: "在吗", reply: "qq-private-10001" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    notice: [{ title: "内部说明", text: "这不该直接发给用户。" }],
  });
  assert.equal(rows(h.view(), "cards", { title: "内部说明" }).length, 0);
  assert.equal(rows(h.view(), "events", { id: ack.event })[0].dispatch_state, "unassigned");
  assert.ok(rows(h.view(), "cards", { key: `dispatch:${ack.event}` }).length, "the owner gets a placement card");
});

test("a placed event moves to its project lane and is reported back to the original chat", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({
    subject: "qq-group-20002",
    actor: "alice",
    summary: "改一下商城",
    reply: "qq-group-20002",
  });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "shop", session: "new", confidence: 0.95, reason: "说的是商城" },
  });
  const work = rows(h.view(), "runs", { rule: "QQ 任务 shop", state: "queued" })[0];
  assert.equal(work.lane, "qq-group-20002/shop");
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.equal(event.dispatch_state, "placed");
  assert.equal(event.dispatch_project, "shop");
  const notice = rows(h.view(), "cards", { title: "任务已分配" }).at(-1)!;
  assert.equal(notice.reply, "qq-group-20002");
  assert.match(notice.text, /shop/);
  assert.equal(rows(h.view(), "dispatch_decisions", { event_id: ack.event })[0].outcome, "placed");
});

test("a placement card answers back where the event came from", () => {
  const h = hub(routing({ sources: { ...base.sources, app: { name: "应用" } } }));
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "qq-private-10001", actor: "alice", reply: "qq-private-10001" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, { outcome: "done" });
  const card = rows(h.view(), "cards", { state: "open" }).at(-1)!;
  assert.equal(card.reply, "qq-private-10001");
  assert.equal(card.grp, "dispatch");
});

test("notices and card answers do not start dispatch rounds", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.act("ingest", "app", {
    id: "notice-1",
    type: "notice.sent",
    subject: "qq-private-10001",
    actor: "alice",
  });
  const rounds = rows(h.view(), "runs", { kind: "dispatch" }).length;
  assert.equal(rounds, 0);
});

test("the dispatch snapshot describes projects from hub facts", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "qq-private-10001", actor: "alice" });
  const job = h.act("claimNext", "w1", "c1");
  const mini = job.context.dispatch.projects.find((one: any) => one.project === "mini");
  assert.equal(mini.description, "迷你项目");
  assert.equal("lastSession" in mini, false, "a project with no finished round has no session to continue");
  assert.equal(mini.canContinue, false);
  assert.deepEqual(mini.preferences, []);
});

test("a person's choice different from the suggestion is recorded as a correction", () => {
  const h = hub(routing({ sources: { ...base.sources, app: { name: "应用" } } }));
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "qq-private-10001", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "ask", confidence: 0.8 },
  });
  const card = rows(h.view(), "cards", { state: "open" }).at(-1)!;
  h.act("answer", card.id, { choice: 1, by: "alice" });
  const correction = rows(h.view(), "dispatch_corrections", { event_id: ack.event })[0];
  assert.equal(correction.chosen, "shop");
  assert.equal(correction.suggested, "mini");
  assert.ok(rows(h.view(), "dispatch_decisions", { event_id: ack.event }).length > 0);
});

test("a failed dispatch stays failed even though a person gets a placement card", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "qq-private-10001", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, { outcome: "failed", error: "模型挂了" });
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.equal(event.dispatch_state, "failed");
  assert.equal(rows(h.view(), "dispatch_decisions", { event_id: ack.event })[0].outcome, "failed");
  assert.ok(rows(h.view(), "cards", { key: `dispatch:${ack.event}` }).length);
});

test("continue does not merge into a round still holding the last session", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "qq-private-10001", actor: "alice", summary: "第一件" });
  let dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "new", confidence: 0.9 },
  });
  const work = h.act("claimNext", "w1", "c2");
  h.act("finish", work.run, work.token, { outcome: "done", session: "session-1", summary: "做完了" });

  h.send({ subject: "qq-private-10001", actor: "alice", summary: "第二件" });
  dispatch = h.act("claimNext", "w1", "c3");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "continue", confidence: 0.9 },
  });
  const holding = h.act("claimNext", "w1", "c4");
  h.act("started", holding.run, holding.token, { session: "session-1" });

  h.send({ subject: "qq-private-10001", actor: "alice", summary: "第三件" });
  dispatch = h.act("claimNext", "w1", "c5");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "continue", confidence: 0.9 },
  });
  const next = rows(h.view(), "runs", { rule: "QQ 任务 mini", state: "queued" }).at(-1)!;
  assert.equal(next.resume, null, "the held session is not opened by a second round");
  assert.equal(next.session, null);
});
