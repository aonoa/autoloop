// Failure modes: a claimed run starts the Agent without its screenshots; a failed download is silent; a malicious file
// name escapes the run folder; the prompt does not name the downloaded file.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("worker-attachments");
const project = join(home, "project");
mkdirSync(project, { recursive: true });
const { createWorker } = await import("../worker/worker.ts");
const { promptFor } = await import("../worker/contract.ts");

const attachment = { id: "att_0123456789abcdef", name: "screenshot.png", mediaType: "image/png", size: 4 };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function job(overrides: Record<string, unknown> = {}) {
  return {
    run: 7,
    token: "run-token",
    attempt: 1,
    rule: { name: "看图改页面", cwd: project, prompt: "按截图改。" },
    agent: { id: "a1", name: "甲", use: "command", access: "edit", command: ["echo", "{prompt}"] },
    session: null,
    askFirst: [],
    context: {
      events: [
        {
          id: "e1",
          source: "insoulforge",
          sourceName: "InSoulForge",
          type: "qq.task",
          subject: "qq-private-1991849113",
          summary: "按钮错位",
          detail: "这个页面按钮错位，改一下",
          link: "",
          receivedAt: "2026-11-15T00:00:00.000Z",
          attachments: [attachment],
        },
      ],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
    },
    ...overrides,
  } as any;
}

test("the worker downloads a run's attachments before launching the agent and names the local file", async () => {
  let claimed = false;
  const downloads: string[] = [];
  const worker = createWorker({
    name: "w1",
    wait: 0,
    hub: {
      async work() {
        if (claimed) return { job: null, cancel: [] };
        claimed = true;
        return { job: job(), cancel: [] };
      },
      async started() {},
      async progress() {},
      async result() {},
      async attachment(run: number, token: string, id: string) {
        assert.deepEqual([run, token, id], [7, "run-token", attachment.id]);
        downloads.push(id);
        return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
      },
    } as any,
  });
  await worker.tick();
  assert.deepEqual(downloads, [attachment.id]);
  const dir = join(home, "worker", "runs", "7-1");
  const file = join(dir, "attachments", "screenshot.png");
  assert.deepEqual(readFileSync(file), png);
  const entry = JSON.parse(readFileSync(join(dir, "entry.json"), "utf8"));
  assert.match(entry.prompt, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(entry.prompt, /截图/);
});

test("a failed attachment download fails the run instead of starting it blind", async () => {
  let claimed = false;
  const worker = createWorker({
    name: "w1",
    wait: 0,
    hub: {
      async work() {
        if (claimed) return { job: null, cancel: [] };
        claimed = true;
        return { job: job(), cancel: [] };
      },
      async started() {},
      async progress() {},
      async result() {},
      async attachment() {
        return new Response("gone", { status: 404 });
      },
    } as any,
  });
  await worker.tick();
  const entry = JSON.parse(readFileSync(join(home, "worker", "runs", "7-1", "entry.json"), "utf8"));
  assert.equal(entry.result.outcome, "failed");
  assert.match(entry.result.error, /附件/);
  assert.equal(existsSync(join(home, "worker", "runs", "7-1", "command-0.sh")), false);
});

test("attachment names are only used as a basename inside the run folder", async () => {
  const bad = { ...attachment, name: "../../escape.png" };
  const worker = createWorker({
    name: "w1",
    wait: 0,
    hub: {
      async work() {
        return {
          job: job({ context: { ...job().context, events: [{ ...job().context.events[0], attachments: [bad] }] } }),
          cancel: [],
        };
      },
      async started() {},
      async progress() {},
      async result() {},
      async attachment() {
        return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
      },
    } as any,
  });
  await worker.tick();
  const entry = JSON.parse(readFileSync(join(home, "worker", "runs", "7-1", "entry.json"), "utf8"));
  assert.equal(entry.result.outcome, "failed");
  assert.equal(existsSync(join(home, "escape.png")), false);
});

test("the prompt lists downloaded attachments as files, never as remote ids", () => {
  const text = promptFor(job(), "/tmp/context.json", [
    { name: "screenshot.png", path: "/tmp/run/attachments/screenshot.png" },
  ]);
  assert.match(text, /attachments\/screenshot\.png/);
  assert.doesNotMatch(text, /att_0123456789abcdef/);
});
