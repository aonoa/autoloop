// Failure modes: published schemas accept an impersonated source, malformed receipts, or credentials in event data;
// the wire contract drifts from the validators, and conformance accepts a server that opens the wrong door.
// Required job structure and inherited object names must not bypass schema checks; Unicode limits count code points.
// FYI notices must accept only an optional boolean without weakening notice limits or changing question receipts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchema } from "../protocol/schema.ts";
import { parseEvent, parseProgress, parseResult } from "../protocol/validate.ts";

test("notice receipts accept an optional boolean fyi and keep all other boundaries", () => {
  const notice = { title: "已设好", text: "每天九点检查", key: "daily-check" };
  for (const item of [notice, { ...notice, fyi: true }, { ...notice, fyi: false }]) {
    const result = { outcome: "done", notice: [item] };
    assert.deepEqual(parseResult(result), result);
    assert.deepEqual(checkSchema("result", result), []);
  }
  for (const item of [
    ...[null, 0, 1, "true", [], {}].map((fyi) => ({ ...notice, fyi })),
    { ...notice, fyi: true, title: "" },
    { ...notice, fyi: true, title: "x".repeat(201) },
    { ...notice, fyi: true, text: " " },
    { ...notice, fyi: true, text: "x".repeat(4001) },
    { ...notice, fyi: true, key: "x".repeat(101) },
    { ...notice, fyi: true, unknown: true },
  ]) {
    const result = { outcome: "done", notice: [item] };
    assert.throws(() => parseResult(result), /notice/);
    assert.ok(checkSchema("result", result).length);
  }
  const tooMany = { outcome: "done", notice: Array(11).fill({ ...notice, fyi: true }) };
  assert.throws(() => parseResult(tooMany), /notice/);
  assert.ok(checkSchema("result", tooMany).length);
  const ask = { outcome: "done", ask: [{ ...notice, options: ["继续", "暂停"], fyi: true }] };
  assert.throws(() => parseResult(ask), /ask/);
  assert.ok(checkSchema("result", ask).length);
});

test("wire schemas agree with event and receipt boundaries", () => {
  for (const input of [
    { id: "one", type: "app.changed" },
    { id: " ", type: "app.changed", summary: null },
    { id: "one", type: "app.changed", source: "other" },
    { id: 7, type: "invalid" },
    { id: "one", type: "bad type" },
    { id: "one", type: "app.changed", reply: "qq-private-10001" },
    { id: "one", type: "app.changed", reply: "qq-group-20002" },
    { id: "one", type: "app.changed", reply: "qq-group-not-a-number" },
    { id: "one", type: "app.changed", reply: "qq-private-not-a-number" },
    { id: "one", type: "app.changed", reply: "https://evil.test" },
  ]) {
    let accepted = true;
    try {
      parseEvent(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("event", input).length === 0, accepted);
  }
  for (const input of [
    { outcome: "done" },
    { outcome: "done", events: [{ id: "x", type: "app.changed" }] },
    { outcome: "unknown" },
    { outcome: "done", ask: [{ title: "选", text: "内容", options: ["一"] }] },
    { outcome: "done", ask: [{ title: "选", text: "内容", options: ["一", "二"], recommend: 2 }] },
    { outcome: "done", later: [{ key: "k", at: "badZ", about: "后来" }] },
  ]) {
    let accepted = true;
    try {
      parseResult(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("result", input).length === 0, accepted);
  }
});

test("events carry bounded attachment references without trusting names or bytes", () => {
  const attachment = {
    id: "att_0123456789abcdef",
    name: "screenshot.png",
    mediaType: "image/png",
    size: 1024,
  };
  const event = { id: "shot", type: "qq.task", attachments: [attachment] };
  assert.deepEqual(parseEvent(event).attachments, [attachment]);
  assert.deepEqual(checkSchema("event", event), []);
  for (const bad of [
    { ...attachment, id: "../etc/passwd" },
    { ...attachment, id: "att_" },
    { ...attachment, name: "../screenshot.png" },
    { ...attachment, name: "shot.exe" },
    { ...attachment, mediaType: "text/html" },
    { ...attachment, size: 0 },
    { ...attachment, size: 24 * 1024 * 1024 + 1 },
    { ...attachment, unknown: true },
  ]) {
    const input = { ...event, attachments: [bad] };
    assert.throws(() => parseEvent(input));
    assert.ok(checkSchema("event", input).length, JSON.stringify(bad));
  }
  const tooMany = { ...event, attachments: Array(9).fill(attachment) };
  assert.throws(() => parseEvent(tooMany));
  assert.ok(checkSchema("event", tooMany).length);
});

test("documents are first-class attachments but keep the same name and type agreement", () => {
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  for (const item of [
    { name: "指标.pdf", mediaType: "application/pdf" },
    { name: "表格.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { name: "汇报.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    { name: "报告.docx", mediaType: docx },
    { name: "打包.zip", mediaType: "application/zip" },
    { name: "说明.md", mediaType: "text/markdown" },
    { name: "指标.csv", mediaType: "text/csv" },
    { name: "数据.json", mediaType: "application/json" },
    { name: "app.log", mediaType: "text/plain" },
  ]) {
    const input = { id: "doc", type: "qq.task", attachments: [{ id: "att_0123456789abcdef", size: 9, ...item }] };
    assert.deepEqual(parseEvent(input).attachments, input.attachments);
    assert.deepEqual(checkSchema("event", input), []);
  }
  const rejected = [
    { name: "报告.doc", mediaType: docx },
    { name: "report.docx", mediaType: "text/plain" },
    { name: "run.sh", mediaType: "text/plain" },
    { name: "page.html", mediaType: "text/plain" },
    { name: "app.exe", mediaType: "application/zip" },
    { name: "x.pdf", mediaType: "application/octet-stream" },
  ];
  for (const bad of rejected) {
    const input = { id: "doc", type: "qq.task", attachments: [{ id: "att_0123456789abcdef", size: 9, ...bad }] };
    assert.throws(() => parseEvent(input), JSON.stringify(bad));
  }
  // The wire schema bounds each field on its own; only the validator knows which names pair with which types.
  const pairedOnly = rejected[1];
  const pairedInput = {
    id: "doc",
    type: "qq.task",
    attachments: [{ id: "att_0123456789abcdef", size: 9, ...pairedOnly }],
  };
  assert.deepEqual(checkSchema("event", pairedInput), []);
  for (const bad of rejected.filter((item) => item !== pairedOnly)) {
    const input = { id: "doc", type: "qq.task", attachments: [{ id: "att_0123456789abcdef", size: 9, ...bad }] };
    assert.ok(checkSchema("event", input).length, JSON.stringify(bad));
  }
});

test("schema checks reject inherited names and incomplete tasks or question cards", () => {
  assert.ok(checkSchema("event", { id: "x", type: "one", constructor: "unexpected" }).length);
  assert.ok(checkSchema("job", { run: 1, token: "t", rule: {}, agent: {}, context: {} }).length);
  assert.ok(
    checkSchema("card", { id: 1, version: 1, kind: "ask", state: "open", title: "选", text: "内容", options: [] })
      .length,
  );
  assert.throws(() => checkSchema("constructor", {}));
});

test("published text limits count Unicode characters, including astral code points", () => {
  const event = { id: "x", type: "one", summary: "😀".repeat(200) };
  assert.deepEqual(checkSchema("event", event), []);
  assert.equal(parseEvent(event).summary, event.summary);
  assert.deepEqual(checkSchema("tell-source", { key: "unicode", text: "😀".repeat(20000) }), []);
  const receipt = { outcome: "done", summary: "😀".repeat(500) };
  assert.deepEqual(checkSchema("result", receipt), []);
  assert.equal(parseResult(receipt).summary, receipt.summary);
});

test("usage must be an object of finite nonnegative amounts", () => {
  for (const usage of [[1], { cost: -1 }, { cost: Infinity }, { input: NaN }]) {
    assert.throws(() => parseResult({ outcome: "done", usage }));
    assert.ok(checkSchema("result", { outcome: "done", usage }).length);
  }
});

test("progress is a bounded step, never an unknown field or an invented time", () => {
  const step = { step: "执行命令：npm test", detail: "先跑测试", kind: "command" };
  assert.deepEqual(checkSchema("progress", step), []);
  assert.deepEqual(parseProgress(step), step);
  assert.deepEqual(checkSchema("progress", { ...step, at: "2026-11-07T02:00:00+08:00" }), []);
  for (const bad of [
    { step: " " },
    { step: "x".repeat(501) },
    { step: "x", detail: "y".repeat(4001) },
    { step: "x", kind: "k".repeat(41) },
    { step: "x", at: "2026-11-07 02:00:00" },
    { step: "x", command: "rm -rf /" },
  ]) {
    assert.throws(() => parseProgress(bad), JSON.stringify(bad).slice(0, 80));
    assert.ok(checkSchema("progress", bad).length);
  }
});

test("the published schema carries dispatch rounds and routes", () => {
  const job = {
    run: 1,
    token: "t",
    attempt: 1,
    kind: "dispatch",
    rule: { name: "调度", cwd: "" },
    agent: { id: "a1", name: "调度", use: "claude", access: "read" },
    session: null,
    askFirst: [],
    context: {
      events: [],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
      dispatch: {
        minConfidence: 0.7,
        create: true,
        workers: ["w1"],
        projects: [
          {
            project: "mini",
            rule: "QQ 任务 mini",
            cwd: "~/mini",
            agent: "a1",
            worker: "w1",
            online: true,
            subjects: ["#mini*"],
            aliases: [],
            description: "迷你项目",
            canContinue: false,
            preferences: [],
          },
        ],
        matters: [{ project: "mini", rule: "QQ 任务 mini", lane: "", stage: "idle", lastRun: 2 }],
        recentRuns: [{ run: 2, project: "mini", rule: "QQ 任务 mini", state: "done", summary: "做完了", at: null }],
      },
    },
  };
  assert.deepEqual(checkSchema("job", job), []);
  const route = { outcome: "done", route: { project: "mini", session: "ask", confidence: 0.8 } };
  assert.deepEqual(checkSchema("result", route), []);
  assert.ok(
    checkSchema("result", { outcome: "done", route: { project: "mini", session: "later", confidence: 2 } }).length,
  );
  const create = {
    outcome: "done",
    create: { project: "shop", description: "商城", confidence: 0.9, cwd: "/srv/shop" },
  };
  assert.deepEqual(checkSchema("result", create), []);
  assert.deepEqual(parseResult(create), create);
  for (const bad of [
    { ...create, create: { project: "shop", description: "商城" } },
    { ...create, create: { project: "shop", description: "商城", confidence: 2 } },
    { ...create, create: { project: "shop", description: "商城", confidence: 0.9, unknown: true } },
  ]) {
    assert.throws(() => parseResult(bad));
    assert.ok(checkSchema("result", bad).length);
  }
});

test("timer timestamps are real calendar dates in the documented ISO format", () => {
  for (const at of ["2000Z", "2026-02-30T10:00:00Z", "2026-01-01T25:00:00Z"]) {
    const result = { outcome: "done", later: [{ key: "later", at, about: "再查" }] };
    assert.throws(() => parseResult(result));
    assert.ok(checkSchema("result", result).length);
  }
  const result = { outcome: "done", later: [{ key: "later", at: "2028-02-29T10:00:00+08:00", about: "再查" }] };
  assert.doesNotThrow(() => parseResult(result));
  assert.deepEqual(checkSchema("result", result), []);
});
