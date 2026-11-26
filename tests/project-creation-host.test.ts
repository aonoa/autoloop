// Failure cases: the host writes a project the kernel never proposed; a failed write leaves a pending record; a write
// succeeds but the event is not queued again; the Activity list and rules diverge.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-creation-"));
const home = join(root, "home");
mkdirSync(home);
const rules = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
rules.sources.qq = { name: "QQ" };
rules.sources.github = { name: "GitHub" };
rules.channels.insoulforge = { name: "QQ 机器人" };
rules.rules.push({
  name: "QQ 任务 mini",
  when: { source: "qq", types: ["qq.task"], subjects: ["qq-private-1/mini*"] },
  to: "a1",
  project: "mini",
  cwd: "~/mini",
  prompt: "处理。",
});
rules.policy = { accept: "off", dispatch: { agent: "a1", minConfidence: 0.7, create: true } };
writeFileSync(join(home, "rules.json"), JSON.stringify(rules, null, 2));
writeFileSync(join(home, "activity.json"), JSON.stringify({ allow: { private: ["1"] }, projects: {} }, null, 2));
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
process.env.AGENT_AUTOLOOP_ACTIVITY_CONFIG = join(home, "activity.json");
const hub = await import("../host/runtime.ts");
after(() => rmSync(root, { recursive: true, force: true }));

test("a proposed project is written to both files, then the event is queued again", () => {
  const ack = hub.execute("ingest", [
    "qq",
    { id: "q1", type: "qq.task", subject: "qq-private-1", summary: "新项目任务" },
  ]);
  const run = hub.execute("claimNext", ["w1", "c1"]);
  hub.execute("finish", [
    run.run,
    run.token,
    {
      outcome: "done",
      create: { project: "shop", description: "商城", confidence: 0.9, cwd: "/srv/shop", worker: "w2" },
    },
  ]);
  const [creation] = hub.pendingCreations();
  assert.ok(creation);
  const applied = hub.applyCreation(creation);
  assert.equal(applied.applied, true, String(applied.error ?? ""));
  const written = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  assert.ok(written.rules.some((one: any) => one.project === "shop" && one.to === "a2"));
  const activity = JSON.parse(readFileSync(join(home, "activity.json"), "utf8"));
  assert.equal(activity.projects.shop.description, "商城");
  assert.equal(hub.getView().get("project_creations", creation.id)!.state, "applied");
  const event = hub.getView().get("events", ack.event)!;
  assert.equal(event.dispatch_state, "queued");
  assert.ok(event.dispatch_run);
  // Consume the dispatch round queued after creation, so it cannot leak into the next test.
  const dispatch = hub.execute("claimNext", ["w1", "c1"]);
  assert.equal(dispatch.kind, "dispatch");
  hub.execute("finish", [dispatch.run, dispatch.token, { outcome: "done", summary: "重新分配" }]);
});

test("a failed write is recorded and does not leave a pending creation", () => {
  const ack = hub.execute("ingest", [
    "qq",
    { id: "q2", type: "qq.task", subject: "qq-private-1", summary: "另一个新项目" },
  ]);
  const run = hub.execute("claimNext", ["w1", "c2"]);
  assert.equal(run.kind, "dispatch");
  hub.execute("finish", [
    run.run,
    run.token,
    { outcome: "done", create: { project: "bad", description: "坏项目", confidence: 0.9, cwd: "/srv/bad" } },
  ]);
  const [creation] = hub.pendingCreations();
  assert.ok(creation);
  // Make the Activity file unreadable after the kernel approved the proposal: the host write must fail, not half-write.
  writeFileSync(join(home, "activity.json"), "{");
  const applied = hub.applyCreation(creation);
  assert.equal(applied.applied, false);
  assert.match(String(applied.error), /Activity 配置/);
  const event = hub.getView().get("events", ack.event)!;
  assert.equal(event.dispatch_state, "unassigned");
  assert.equal(hub.getView().get("project_creations", creation.id)!.state, "failed");
  assert.equal(hub.pendingCreations().length, 0);
});

test("a project created from another source inherits that source and event type", () => {
  writeFileSync(join(home, "activity.json"), JSON.stringify({ allow: { private: ["1"] }, projects: {} }, null, 2));
  const ack = hub.execute("ingest", [
    "github",
    { id: "gh1", type: "github.issue", subject: "owner/repo#42", summary: "新仓库任务" },
  ]);
  const run = hub.execute("claimNext", ["w1", "c3"]);
  assert.equal(run.kind, "dispatch");
  hub.execute("finish", [
    run.run,
    run.token,
    {
      outcome: "done",
      create: { project: "issues", description: "问题处理", confidence: 0.9, subjects: ["owner/repo#*"] },
    },
  ]);
  const [creation] = hub.pendingCreations();
  assert.ok(creation);
  const applied = hub.applyCreation(creation);
  assert.equal(applied.applied, true, String(applied.error ?? ""));
  const written = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  const rule = written.rules.find((one: any) => one.project === "issues");
  assert.equal(rule.when.source, "github");
  assert.deepEqual(rule.when.types, ["github.issue"]);
  assert.deepEqual(rule.when.subjects, ["owner/repo#*"]);
  assert.match(rule.prompt, /来源 github/);
  assert.equal(hub.getView().get("events", ack.event)!.dispatch_state, "queued");
});
