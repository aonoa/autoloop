// Failure cases: a valid config edit leaves the old project list in memory; a broken edit replaces the working list;
// the registration still tells the model the old projects after a reload; a reload stops answering requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createService, parseConfig } from "../activity.ts";

const config = parseConfig({
  activity: { url: "ws://127.0.0.1:1/activities/ws", token: "a".repeat(32) },
  hub: { url: "http://127.0.0.1:1", sourceKey: "source", ownerKey: "owner" },
  allow: { private: ["10001001"], groups: ["20002002"], actor: "10001001", senders: ["10001001"] },
  projects: { shop: { description: "商城", rule: "QQ 任务" } },
});
const hub = {
  submit: async () => ({}),
  outcome: async () => ({ runs: [] }),
  state: async () => ({ cards: [], runs: [] }),
  answer: async () => ({}),
};

test("a new project takes effect in requests and instructions without a restart", async () => {
  const service = createService(config, hub);
  const before = await service.handle({ action: "projects" }, { sender_id: "10001001" });
  assert.deepEqual((before as any).result.projects, [{ project: "shop", description: "商城", rule: "QQ 任务" }]);
  assert.doesNotMatch(service.instructions(), /site/);
  const next = parseConfig({
    ...JSON.parse(JSON.stringify(config)),
    projects: { ...config.projects, site: { description: "官网", rule: "QQ 任务 site" } },
  });
  service.update(next);
  const after = await service.handle({ action: "projects" }, { sender_id: "10001001" });
  assert.deepEqual(
    (after as any).result.projects.map((one: any) => one.project),
    ["shop", "site"],
  );
  assert.match(service.instructions(), /- site：官网/);
  const submitted: any[] = [];
  const accepting = createService(next, {
    ...hub,
    submit: async (event) => (submitted.push(event), { routed: ["QQ 任务 site"] }),
  });
  const result: any = await accepting.handle(
    { action: "submit", project: "site", text: "首页", target_session: "group:20002002" },
    { sender_id: "10001001" },
  );
  assert.equal(result.success, true);
  assert.equal(submitted[0].subject, "qq-group-20002002/site");
});
