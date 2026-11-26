// Failure cases: a dispatcher creates a project without the policy saying so; a low-confidence or invented node creates
// one; create and route are both honoured; a failed write leaves the event pending forever; a created project is not
// scheduled again; the host writes a project the kernel never approved; duplicate or off-allowlist proposals slip through.
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
    const decided = decide(view, { type, args }, now++, { secret: "create", publicUrl: "https://hub.test" });
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  let events = 0;
  const send = (event: object = {}) =>
    act("ingest", "app", { id: `e${++events}`, type: "qq.task", subject: "qq-private-1", ...event });
  return { act, send, view: () => view, log };
}

const project = (name: string, cwd: string, agent: string, subjects: string[]) => ({
  name: `QQ 任务 ${name}`,
  when: { source: "app", types: ["qq.task"], subjects },
  to: agent,
  cwd,
  project: name,
  prompt: "处理。",
  resume: true,
});

const routing = (extra: object = {}) => ({
  ...base,
  sources: { ...base.sources, app: { name: "应用" } },
  agents: {
    ...base.agents,
    a1: { ...base.agents.a1, worker: "w1" },
    a2: { ...base.agents.a2, worker: "w2" },
    dispatcher: { ...base.agents.a1, name: "调度", worker: "w1" },
  },
  rules: [project("mini", "~/mini", "a1", ["qq-private-1/mini*"])],
  policy: { accept: "off", dispatch: { agent: "dispatcher", minConfidence: 0.7, create: true } },
  ...extra,
});

test("a dispatcher cannot create a project unless policy.dispatch.create is on", () => {
  const h = hub(routing({ policy: { accept: "off", dispatch: { agent: "dispatcher" } } }));
  const ack = h.send({ summary: "新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.9 },
  });
  assert.equal(rows(h.view(), "project_creations").length, 0);
  assert.equal(rows(h.view(), "events", { id: ack.event })[0].dispatch_state, "unassigned");
});

test("a valid proposal records one pending creation and does not dispatch the event yet", () => {
  const h = hub(routing());
  const ack = h.send({ summary: "新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    create: {
      project: "shop",
      description: "商城前端",
      confidence: 0.92,
      cwd: "/srv/shop",
      worker: "w2",
      agent: "a2",
    },
  });
  const [creation] = rows(h.view(), "project_creations");
  assert.equal(creation.state, "pending");
  assert.equal(creation.project, "shop");
  assert.equal(creation.worker, "w2");
  assert.equal(creation.event_type, "qq.task");
  assert.equal(creation.confidence, 0.92);
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.equal(event.dispatch_state, "creating");
  assert.equal(rows(h.view(), "runs", { rule: "QQ 任务 shop" }).length, 0);
});

test("create and route together are refused instead of choosing one", () => {
  const h = hub(routing());
  const ack = h.send({ summary: "新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    route: { project: "mini", session: "new", confidence: 0.9 },
    create: { project: "shop", description: "商城", confidence: 0.9 },
  });
  assert.equal(rows(h.view(), "project_creations").length, 0);
  assert.equal(rows(h.view(), "events", { id: ack.event })[0].dispatch_state, "unassigned");
});

test("a proposal naming an unregistered worker, a bad folder, or an existing project is refused", () => {
  const h = hub(routing());
  for (const [index, create] of [
    { project: "shop", description: "商城", confidence: 0.9, worker: "nope" },
    { project: "shop", description: "商城", confidence: 0.9, cwd: "relative/path" },
    { project: "mini", description: "已有项目", confidence: 0.9 },
  ].entries()) {
    const ack = h.send({ summary: `新项目任务 ${index}` });
    const run = h.act("claimNext", "w1", `c${index}`);
    h.act("finish", run.run, run.token, { outcome: "done", create });
    assert.equal(rows(h.view(), "events", { id: ack.event })[0].dispatch_state, "unassigned");
  }
  assert.equal(rows(h.view(), "project_creations").length, 0);
});

test("a worker allowlist narrows where an automatically created project may land", () => {
  const h = hub(
    routing({ policy: { accept: "off", dispatch: { agent: "dispatcher", create: true, workers: ["w1"] } } }),
  );
  const ack = h.send({ summary: "新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.9, worker: "w2", agent: "a2" },
  });
  assert.equal(rows(h.view(), "project_creations").length, 0);
  assert.equal(rows(h.view(), "events", { id: ack.event })[0].dispatch_state, "unassigned");
});

test("a host write failure is reported and the event is left for a person", () => {
  const h = hub(routing());
  const ack = h.send({ summary: "新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.9 },
  });
  const [creation] = rows(h.view(), "project_creations");
  h.act("projectCreationResult", creation.id, "failed", "目录不可写");
  h.act("projectCreationFailed", ack.event, "目录不可写");
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.equal(event.dispatch_state, "unassigned");
  assert.equal(rows(h.view(), "project_creations", { id: creation.id })[0].state, "failed");
});

test("a created project queues the event for a fresh dispatch round", () => {
  const h = hub(routing());
  const ack = h.send({ summary: "新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.9 },
  });
  const [creation] = rows(h.view(), "project_creations");
  h.act("projectCreationResult", creation.id, "applied", null);
  h.act("projectCreated", ack.event, "shop");
  const event = rows(h.view(), "events", { id: ack.event })[0];
  assert.equal(event.dispatch_state, "queued");
  assert.ok(event.dispatch_run);
  const again = h.act("claimNext", "w1", "c2");
  assert.equal(again.kind, "dispatch");
});

test("a low-confidence proposal is refused and leaves the event unassigned", () => {
  const h = hub(routing());
  const ack = h.send({ summary: "新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.4 },
  });
  assert.equal(rows(h.view(), "project_creations").length, 0);
  assert.equal(rows(h.view(), "events", { id: ack.event })[0].dispatch_state, "unassigned");
});

test("a worker allowlist applies even when the proposal names neither worker nor agent", () => {
  // The dispatcher is the only Agent on w1; the host's default choice for a new project would land on w2.
  const agents = {
    a1: { ...base.agents.a1, worker: "w2" },
    a2: { ...base.agents.a2, worker: "w2" },
    dispatcher: { ...base.agents.a1, name: "调度", worker: "w1" },
  };
  const rules = parseRules(
    JSON.stringify({
      ...routing(),
      agents,
      policy: { accept: "off", dispatch: { agent: "dispatcher", create: true, workers: ["w1"] } },
    }),
    0,
    "UTC",
  );
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, { secret: "create", publicUrl: "https://hub.test" });
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  const ack = act("ingest", "app", { id: "allowlist", type: "qq.task", subject: "qq-private-1", summary: "新项目" });
  const run = act("claimNext", "w1", "c1");
  act("finish", run.run, run.token, {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.9 },
  });
  assert.equal(rows(view, "project_creations").length, 0);
  assert.equal(rows(view, "events", { id: ack.event })[0].dispatch_state, "unassigned");
});

test("a duplicate pending proposal for the same project is refused", () => {
  const h = hub(routing());
  const first = h.send({ summary: "第一个新项目任务" });
  const run = h.act("claimNext", "w1", "c1");
  h.act("finish", run.run, run.token, {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.9 },
  });
  const second = h.send({ summary: "第二个新项目任务" });
  const dispatch = h.act("claimNext", "w1", "c2");
  assert.equal(dispatch.kind, "dispatch");
  h.act("finish", dispatch.run, dispatch.token, {
    outcome: "done",
    create: { project: "shop", description: "又一个商城", confidence: 0.9 },
  });
  assert.equal(rows(h.view(), "project_creations").length, 1);
  assert.equal(rows(h.view(), "events", { id: second.event })[0].dispatch_state, "unassigned");
  assert.equal(rows(h.view(), "events", { id: first.event })[0].dispatch_state, "creating");
});
