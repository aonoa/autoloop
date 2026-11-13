// Failure modes: an assessor round is given the ordinary work prompt and does the work; its verdict can't be written in a
// receipt; a verdict written in a receipt is dropped before it reaches the hub; the assess prompt tells it to work instead
// of judge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { promptFor, readMessage, resultFrom } from "../worker/contract.ts";
import type { Job } from "../protocol/job.ts";

const job = (kind?: "assess"): Job =>
  ({
    run: 1,
    token: "t",
    attempt: 1,
    ...(kind && { kind }),
    rule: { name: "意见", cwd: "~/x", prompt: "按手册做。" },
    agent: { id: "a3", name: "丙", use: "command", access: "read" },
    session: null,
    askFirst: [],
    context: {
      events: [
        {
          id: "e1",
          source: "app",
          sourceName: "应用",
          type: "feedback.new",
          subject: "#1",
          summary: "请甲看一下",
          detail: "",
          link: "",
          receivedAt: "2026-11-05T00:00:00.000Z",
        },
      ],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
    },
  }) as Job;

test("an assessor round is told to judge, not to work", () => {
  const text = promptFor(job("assess"), "/tmp/context.json");
  assert.match(text, /判断该不该接/);
  assert.match(text, /不要改文件/);
  assert.match(text, /"verdict"/);
  assert.ok(!text.includes("按手册做。"), "the rule's work prompt is not given to the assessor");
});

test("an ordinary round keeps its work prompt", () => {
  const text = promptFor(job(), "/tmp/context.json");
  assert.match(text, /按手册做。/);
  assert.ok(!text.includes("判断该不该接"));
});

test("a verdict written in a receipt reaches the hub", () => {
  const said = ["接。", "```agent-autoloop", '{"verdict":{"decision":"accept","reason":"确实在做"}}', "```"].join("\n");
  const message = readMessage(said);
  assert.equal(message.problem, undefined);
  assert.deepEqual(message.receipt, { verdict: { decision: "accept", reason: "确实在做" } });
  const { result, problem } = resultFrom(message, {});
  assert.equal(problem, undefined);
  assert.equal(result.verdict?.decision, "accept");
});

test("a report written in a receipt reaches the hub", () => {
  const said = ["改好了。", "```agent-autoloop", '{"report":{"state":"ready","note":"三个文件"}}', "```"].join("\n");
  const { result, problem } = resultFrom(readMessage(said), {});
  assert.equal(problem, undefined);
  assert.deepEqual(result.report, { state: "ready", note: "三个文件" });
});
