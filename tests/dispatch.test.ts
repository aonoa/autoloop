// Failure modes: dispatch turns on without being asked and changes routing; a dispatcher picks a project the event's source
// cannot use, or one whose node is offline, and work is started anyway; a low-confidence guess is executed; a session
// choice is ignored and two projects share history; a dispatcher that fails leaves the event pending forever; a project's
// repository alias is ignored, so a GitHub event that names its project still needs a human.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
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
    act("ingest", source, { id: `e${++events}`, type: "qq.task", subject: "#1", ...event });
  const advance = (ms: number) => (now += ms);
  return { act, send, advance, view: () => view, log };
}

const project = (name: string, cwd: string, agent: string, subjects: string[], aliases?: string[]) => ({
  name: `QQ 任务 ${name}`,
  when: { source: "app", types: ["qq.task"], subjects },
  to: agent,
  cwd,
  group: name,
  prompt: `处理 ${name}。`,
  project: name,
  ...(aliases && { aliases }),
  resume: true,
});

const dispatcher = (agent = "a1", minConfidence = 0.7) => ({ agent, minConfidence });

function routing(extra: object = {}) {
  return {
    ...base,
    sources: {
      ...base.sources,
      app: { name: "应用", policy: { allowlist: ["alice"] } },
    },
    agents: {
      ...base.agents,
      a1: { ...base.agents.a1, worker: "w1" },
      a2: { ...base.agents.a2, worker: "w2" },
      a4: { ...base.agents.a1, name: "调度", worker: "w1" },
    },
    rules: [project("mini", "~/mini", "a1", ["#mini*"]), project("shop", "~/shop", "a2", ["#shop*"], ["owner/shop#*"])],
    policy: { accept: "gate", dispatch: dispatcher() },
    ...extra,
  };
}

test("with no dispatch policy an unrouted event stays unrouted and starts nothing", () => {
  const h = hub(routing({ policy: { accept: "gate" } }));
  const ack = h.send({ subject: "somewhere-else", actor: "alice" });
  assert.deepEqual(ack.routed, []);
  assert.equal(rows(h.view(), "runs").length, 0);
  assert.equal(rows(h.view(), "cards", { kind: "ask" }).length, 0);
});

test("an unrouted event gets a read-only dispatch round that names only the projects it may choose", () => {
  const h = hub(routing());
  const ack = h.send({ subject: "somewhere-else", actor: "alice" });
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const job = h.act("claimNext", "w1", "c1");
  assert.equal(job.kind, "dispatch");
  assert.equal(job.agent.access, "read");
  assert.equal(job.agent.id, "a1");
  assert.deepEqual(job.context.dispatch!.projects.map((one: any) => one.project).sort(), ["mini", "shop"]);
  assert.deepEqual(JSON.parse(rows(h.view(), "events", { id: ack.event })[0].routed), []);
});

test("a dispatcher's route starts the chosen project on its own node and records why", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "shop", session: "new", confidence: 0.93, reason: "用户说的是商城" },
  });
  const [run] = rows(h.view(), "runs", { state: "queued" });
  assert.equal(run.rule, "QQ 任务 shop");
  assert.equal(run.agent, "a2");
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.deepEqual(JSON.parse(event.routed), ["QQ 任务 shop"]);
  const [decision] = rows(h.view(), "decisions", { event_id: ack.event, rule: "QQ 任务 shop" });
  assert.equal(decision.reason, "dispatched");
  assert.equal(decision.scope, "用户说的是商城");
});

test("a project the dispatcher invents, or one its source cannot use, is refused and never executed", () => {
  for (const route of [
    { project: "missing", session: "new", confidence: 0.99 },
    { project: "shop", session: "new", confidence: 0.99 },
  ]) {
    const h = hub(routing());
    h.act("heartbeat", "w1", []);
    h.act("heartbeat", "w2", []);
    const ack = h.send({ subject: "somewhere-else", actor: "alice", type: "not-a-task" });
    const dispatch = h.act("claimNext", "w1", "c1");
    h.act("finish", dispatch.run, dispatch.token, { outcome: "done", route });
    assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
    assert.deepEqual(JSON.parse(rows(h.view(), "events", { id: ack.event })[0].routed), []);
    const card = rows(h.view(), "cards", { state: "open" }).at(-1);
    assert.ok(card, "a refused route is shown to a person instead of disappearing");
    assert.match(card.text, /没有派发|找不到|不能接|没有能接/);
  }
});

test("a low-confidence route is left for a person, not guessed", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "shop", session: "new", confidence: 0.4, reason: "也许是商城" },
  });
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
  const card = rows(h.view(), "cards", { state: "open" }).at(-1);
  assert.ok(card, "the owner gets a card to place it");
  assert.match(card.text, /拿不准|置信|项目/);
});

test("continue keeps the project's lane, while new starts a separate session on the same project", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const first = h.send({ subject: "somewhere-else", actor: "alice", summary: "先做一版" });
  let dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "new", confidence: 0.9 },
  });
  let work = h.act("claimNext", "w1", "c2");
  assert.equal(work.rule.name, "QQ 任务 mini");
  h.act("finish", work.run, work.token, { outcome: "done", session: "session-1", summary: "做完了" });
  const second = h.send({ subject: "somewhere-else", actor: "alice", summary: "接着改" });
  dispatch = h.act("claimNext", "w1", "c3");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "continue", confidence: 0.9 },
  });
  work = h.act("claimNext", "w1", "c4");
  assert.equal(work.session, "session-1", "continue resumes the project's last session");
  assert.notEqual(first.event, second.event);
});

test("a dispatcher that fails or answers without a route leaves the event unassigned and does not retry forever", () => {
  for (const result of [{ outcome: "failed", error: "模型挂了" }, { outcome: "done" }]) {
    const h = hub(routing());
    h.act("heartbeat", "w1", []);
    h.act("heartbeat", "w2", []);
    h.send({ subject: "somewhere-else", actor: "alice" });
    const dispatch = h.act("claimNext", "w1", "c1");
    h.act("finish", dispatch.run, dispatch.token, result);
    assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
    assert.ok(
      rows(h.view(), "cards", { state: "open" }).some(
        (card) => card.title === "有件事没分配到项目" || /没.*派|未分配|拿不准|没有给出项目/.test(card.text),
      ),
    );
  }
});

test("a project's repository alias routes a GitHub event without asking the model", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.act("ingest", "app", {
    id: "gh-1",
    type: "qq.task",
    subject: "owner/shop#42",
    actor: "alice",
    summary: "修一下结算",
  });
  assert.deepEqual(ack.routed, ["QQ 任务 shop"]);
  assert.equal(rows(h.view(), "runs", { kind: "dispatch" }).length, 0);
});

test("each node only claims work for projects placed on it", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "shop", session: "new", confidence: 0.95 },
  });
  assert.equal(h.act("claimNext", "w1", "c2"), null, "shop's agent is on w2");
  const job = h.act("claimNext", "w2", "c3");
  assert.equal(job.rule.name, "QQ 任务 shop");
});

test("an unlisted sender cannot reach a project through an alias or a dispatcher", () => {
  const alias = hub(routing());
  const aliasAck = alias.send({ subject: "#mini/billing", actor: "mallory" });
  assert.deepEqual(aliasAck.routed, []);
  assert.equal(rows(alias.view(), "runs", { state: "queued" }).length, 0);

  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "somewhere-else", actor: "mallory" });
  const dispatch = h.act("claimNext", "w1", "c1");
  assert.equal(dispatch, null, "a refused event never reaches the dispatcher");
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
  assert.deepEqual(JSON.parse(rows(h.view(), "events", { id: ack.event })[0].routed), []);
});

test("a dispatcher cannot place work on a node that has gone offline", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.advance(3 * 60_000);
  h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "shop", session: "new", confidence: 0.99 },
  });
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0);
  assert.match(rows(h.view(), "cards", { state: "open" }).at(-1)!.text, /没上线|离线/);
});

test("new starts a separate session even when the project already has a queued round", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "new", confidence: 0.9 },
  });
  const [first] = rows(h.view(), "runs", { rule: "QQ 任务 mini", state: "queued" });
  const holding = h.act("claimNext", "w1", "c1b");
  const secondAck = h.send({ subject: "somewhere-else", actor: "alice", summary: "另一件" });
  const next = h.act("claimNext", "w1", "c2");
  assert.equal(next.kind, "dispatch");
  h.act("finish", next.run, next.token, {
    outcome: "done",
    route: { project: "mini", session: "new", confidence: 0.9 },
  });
  const queued = rows(h.view(), "runs", { rule: "QQ 任务 mini", state: "queued" });
  assert.equal(queued.length, 1, "the first round is still claimed; the new one is separate");
  assert.notEqual(queued[0].id, holding.run);
  assert.ok(queued.every((run) => run.session === null && run.resume === null));
  assert.notEqual(first.id, queued[0].id);
  assert.notEqual(ack.event, secondAck.event);
});

test("ask leaves the choice to a person, and their answer places the event", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const ack = h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "ask", confidence: 0.82, reason: "可能是 mini" },
  });
  assert.equal(rows(h.view(), "runs", { state: "queued" }).length, 0, "ask must not start work");
  const card = rows(h.view(), "cards", { state: "open" }).at(-1)!;
  assert.equal(card.kind, "ask");
  assert.match(card.title, /项目/);
  h.act("answer", card.id, { choice: 0, by: "alice" });
  const queued = rows(h.view(), "runs", { state: "queued" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].rule, "QQ 任务 mini");
  assert.deepEqual(JSON.parse(rows(h.view(), "events", { id: ack.event })[0].routed), ["QQ 任务 mini"]);
});

test("ask can place the event in another project when the person picks it", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "ask", confidence: 0.82 },
  });
  const card = rows(h.view(), "cards", { state: "open" }).at(-1)!;
  h.act("answer", card.id, { choice: 1, by: "alice" });
  assert.equal(rows(h.view(), "runs", { state: "queued" }).at(-1)!.rule, "QQ 任务 shop");
});

test("a dispatch snapshot leaves out its own rounds and exposes only reachable projects", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "somewhere-else", actor: "alice" });
  const job = h.act("claimNext", "w1", "c1");
  assert.ok(job.context.dispatch.projects.every((one: any) => one.project !== "调度"));
  assert.ok(job.context.dispatch.matters.every((one: any) => one.rule !== "调度"));
});

test("each unrouted event gets its own dispatch round, so none is left behind", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  const first = h.send({ subject: "somewhere-else", actor: "alice", summary: "第一件" });
  const second = h.send({ subject: "somewhere-else", actor: "alice", summary: "第二件" });
  assert.equal(rows(h.view(), "runs", { kind: "dispatch", state: "queued" }).length, 2);

  const one = h.act("claimNext", "w1", "c1");
  assert.equal(one.context.events.length, 1, "a dispatch round reads exactly one event");
  h.act("finish", one.run, one.token, {
    outcome: "done",
    route: { project: "mini", session: "new", confidence: 0.9 },
  });
  const two = h.act("claimNext", "w1", "c2");
  assert.equal(two.context.events.length, 1);
  h.act("finish", two.run, two.token, {
    outcome: "done",
    route: { project: "shop", session: "new", confidence: 0.9 },
  });

  assert.deepEqual(JSON.parse(rows(h.view(), "events", { id: first.event })[0].routed), ["QQ 任务 mini"]);
  assert.deepEqual(JSON.parse(rows(h.view(), "events", { id: second.event })[0].routed), ["QQ 任务 shop"]);
});

test("a dispatcher cannot put new work into a project that is waiting on a person", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "#mini-1", actor: "alice", summary: "先做这件" });
  const blocked = h.act("claimNext", "w1", "c1");
  assert.equal(blocked.rule.name, "QQ 任务 mini");
  h.act("finish", blocked.run, blocked.token, {
    outcome: "done",
    report: { state: "blocked", note: "等账号权限" },
  });

  h.send({ subject: "somewhere-else", actor: "alice", summary: "再塞一件" });
  const dispatch = h.act("claimNext", "w1", "c2");
  assert.equal(dispatch.kind, "dispatch");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    route: { project: "mini", session: "continue", confidence: 0.99 },
  });
  assert.equal(rows(h.view(), "runs", { rule: "QQ 任务 mini", state: "queued" }).length, 0);
  assert.match(rows(h.view(), "cards", { state: "open" }).at(-1)!.text, /不能接新活/);
});

test("an alias cannot bypass a project that is waiting on a person", () => {
  const h = hub(routing());
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "#mini-1", actor: "alice", summary: "先做这件" });
  const blocked = h.act("claimNext", "w1", "c1");
  h.act("finish", blocked.run, blocked.token, {
    outcome: "done",
    report: { state: "blocked", note: "等账号权限" },
  });

  const ack = h.send({ subject: "#mini-2", actor: "alice", summary: "别名事件" });
  assert.deepEqual(ack.routed, []);
  assert.equal(rows(h.view(), "runs", { rule: "QQ 任务 shop", state: "queued" }).length, 0);
  assert.equal(rows(h.view(), "runs", { rule: "QQ 任务 mini", state: "queued" }).length, 0);
});

test("a real rule named 调度 is not mistaken for the internal dispatch round", () => {
  const named = {
    name: "调度",
    when: { source: "app", types: ["qq.task"], subjects: ["#named*"] },
    to: "a1",
    cwd: "~/named",
    group: "named",
    prompt: "这是用户自己的规则。",
    project: "named",
  };
  const h = hub(routing({ rules: [...routing().rules, named] }));
  h.act("heartbeat", "w1", []);
  h.act("heartbeat", "w2", []);
  h.send({ subject: "somewhere-else", actor: "alice" });
  const dispatch = h.act("claimNext", "w1", "c1");
  assert.equal(dispatch.kind, "dispatch");
  assert.equal(dispatch.rule.name, "调度", "a person still reads the dispatcher by its name");
  assert.equal(dispatch.rule.cwd, "", "the internal round takes no directory from a user rule");
  assert.equal(dispatch.thread, undefined, "the internal round names no user matter");
});
