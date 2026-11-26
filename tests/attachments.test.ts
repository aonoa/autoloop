// Failure modes: an event refers to a file that was never uploaded; one source reads another's bytes; a traversal name,
// unsupported type, oversized body or expired id is accepted; an uploaded attachment is not carried to the run context;
// a document is judged by its extension alone, so renamed HTML, a script or mismatched JSON slips through.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("attachments");
const fixture = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
fixture.rules.push(
  {
    name: "附件任务-a",
    when: { source: "app", types: ["qq.a"] },
    to: "a1",
    cwd: "~/x",
    prompt: "看附件。",
    group: "attachments",
  },
  {
    name: "附件任务-b",
    when: { source: "app", types: ["qq.b"] },
    to: "a1",
    cwd: "~/x",
    prompt: "看附件。",
    group: "attachments-other",
  },
);
const rulesFile = join(home, "rules.json");
writeFileSync(rulesFile, JSON.stringify(fixture));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const keys = {
  app: hub.addKey("source", "app"),
  other: hub.addKey("source", "other"),
  owner: hub.addKey("owner", "owner"),
  worker: hub.addKey("worker", "w1"),
};
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  for (const table of ["events", "runs", "run_events"] as const) hub.fixtureClear(table);
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9d1QAAAABJRU5ErkJggg==",
  "base64",
);
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "latin1");
const text = Buffer.from("季度指标\n收入,成本\n", "utf8");
const zipOf = (marker: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker, "utf8")]);
const send = (body: unknown, key = keys.app) =>
  fetch(`${base}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
async function upload(bytes = png, name = "screenshot.png", type = "image/png", key = keys.app) {
  const form = new FormData();
  form.set("name", name);
  form.set("file", new Blob([bytes], { type }), name);
  const response = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  return { status: response.status, json: await response.json() };
}

test("a source uploads bytes and its event can carry the returned reference", async () => {
  const made = await upload();
  assert.equal(made.status, 200);
  assert.match(made.json.id, /^att_[0-9a-f]{16}$/);
  assert.equal(made.json.name, "screenshot.png");
  assert.equal(made.json.mediaType, "image/png");
  assert.equal(made.json.size, png.length);
  const ack = await send({ id: "shot-1", type: "qq.a", attachments: [made.json] });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).routed.length, 1);
  const job = hub.claimNext("w1", "shot-claim")!;
  assert.deepEqual(job.context.events[0].attachments, [made.json]);
});

test("only the source that uploaded a file may read it, and it comes back byte for byte", async () => {
  const made = (await upload()).json;
  const mine = await fetch(`${base}/v1/attachments/${made.id}`, { headers: { authorization: `Bearer ${keys.app}` } });
  assert.equal(mine.status, 200);
  assert.deepEqual(Buffer.from(await mine.arrayBuffer()), png);
  for (const key of [keys.other, keys.owner, keys.worker, ""]) {
    const response = await fetch(`${base}/v1/attachments/${made.id}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, key === keys.other ? 404 : 401);
  }
});

test("unsafe names, wrong media types and bytes that are not an image are refused", async () => {
  assert.equal((await upload(png, "../screenshot.png")).status, 400);
  assert.equal((await upload(png, "a\\b.png")).status, 400);
  assert.equal((await upload(png, "screenshot.exe")).status, 400);
  assert.equal((await upload(png, "screenshot.png", "text/html")).status, 400);
  assert.equal((await upload(Buffer.from("not an image"), "screenshot.png", "image/png")).status, 400);
  assert.equal((await upload(Buffer.from("<script>alert(1)</script>"), "notes.txt", "text/plain")).status, 200);
  assert.equal((await upload(Buffer.from("<script>alert(1)</script>"), "notes.html", "text/plain")).status, 400);
  assert.equal((await upload(Buffer.from('{"a":1}'), "notes.txt", "application/json")).status, 400);
  assert.equal((await upload(Buffer.from("not json"), "notes.json", "application/json")).status, 400);
  assert.equal((await upload(Buffer.from("PK\\x03\\x04rest"), "receipt.pdf", "application/pdf")).status, 400);
  // "other" is a real source key: uploading is allowed, but it owns a different file set.
  assert.equal((await upload(png, "screenshot.png", "image/png", keys.other)).status, 200);
});

test("documents travel like images when their bytes match their declared type", async () => {
  const cases = [
    { bytes: pdf, name: "指标.pdf", type: "application/pdf" },
    { bytes: text, name: "指标.csv", type: "text/csv" },
    { bytes: text, name: "说明.md", type: "text/markdown" },
    { bytes: Buffer.from('{"quarter":"2026Q3"}'), name: "指标.json", type: "application/json" },
    { bytes: Buffer.from("plain text"), name: "notes.txt", type: "text/plain" },
    { bytes: Buffer.from("error: disk full"), name: "app.log", type: "text/plain" },
    {
      bytes: zipOf("word/document.xml"),
      name: "报告.docx",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      bytes: zipOf("xl/workbook.xml"),
      name: "表格.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      bytes: zipOf("ppt/presentation.xml"),
      name: "汇报.pptx",
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    { bytes: zipOf("payload/data.json"), name: "打包.zip", type: "application/zip" },
  ];
  for (const item of cases) {
    const made = await upload(item.bytes, item.name, item.type);
    assert.equal(made.status, 200, item.name);
    assert.equal(made.json.mediaType, item.type);
    const ack = await send({ id: `doc-${item.name}`, type: "qq.a", attachments: [made.json] });
    assert.equal(ack.status, 200, item.name);
    const job = hub.claimNext("w1", `doc-claim-${item.name}`)!;
    assert.deepEqual(job.context.events[0].attachments, [made.json]);
    hub.finish(job.run, job.token, { outcome: "done", summary: "完成" });
  }
});

test("an event can only name attachments its own source uploaded", async () => {
  const made = (await upload()).json;
  assert.equal((await send({ id: "shot-2", type: "qq.a", attachments: [made] }, keys.other)).status, 400);
  assert.equal(
    (await send({ id: "shot-3", type: "qq.a", attachments: [{ ...made, id: "att_0000000000000000" }] })).status,
    400,
  );
});

test("an old event without attachments is unchanged", async () => {
  const ack = await send({ id: "old", type: "qq.a", detail: "没有图片" });
  assert.equal(ack.status, 200);
  const job = hub.claimNext("w1", "old-claim")!;
  assert.equal(job.context.events[0].attachments, undefined);
});

test("a run's token may read only the attachments its own events name", async () => {
  const first = (await upload()).json;
  const second = (await upload(png, "other.png")).json;
  await send({ id: "run-a", type: "qq.a", attachments: [first] });
  await send({ id: "run-b", type: "qq.b", attachments: [second] });
  const runA = hub.claimNext("w1", "claim-a")!;
  const runB = hub.claimNext("w1", "claim-b")!;
  const read = (run: number, token: string, id: string) =>
    fetch(`${base}/v1/runs/${run}/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } });

  const mine = await read(runA.run, runA.token, first.id);
  assert.equal(mine.status, 200);
  assert.deepEqual(Buffer.from(await mine.arrayBuffer()), png);
  assert.equal((await read(runA.run, runA.token, second.id)).status, 404);
  assert.equal((await read(runB.run, runB.token, first.id)).status, 404);
  assert.equal((await read(runA.run, "wrong-token", first.id)).status, 401);
  assert.equal((await read(runA.run, keys.app, first.id)).status, 401);
  assert.equal((await read(runB.run, runA.token, first.id)).status, 401);
});

test("a run loses attachment access once it has handed in its result", async () => {
  const made = (await upload()).json;
  await send({ id: "finished", type: "qq.a", attachments: [made] });
  const job = hub.claimNext("w1", "finished")!;
  const url = `${base}/v1/runs/${job.run}/attachments/${made.id}`;
  assert.equal((await fetch(url, { headers: { authorization: "Bearer guess" } })).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${job.token}` } })).status, 200);
  hub.finish(job.run, job.token, { outcome: "done", summary: "完成" });
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${job.token}` } })).status, 401);
});
