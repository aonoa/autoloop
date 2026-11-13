// Failure modes: an internal event (timer, schedule, replay, manual run, answer) starts a round without a decision, so
// `decisions` claims one per event and rule but the audit trail has a hole; dispatching the same event twice duplicates it.
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
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, { secret: "s", publicUrl: "https://hub.test" });
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  return {
    act,
    advance: (ms: number) => (now += ms),
    view: () => view,
    send: (event: object, source = "app") =>
      act("ingest", source, { id: "e1", type: "feedback.new", subject: "#1", ...event }),
  };
}

test("a due timer leaves a decision as well as a mandate", () => {
  const h = hub();
  h.act("runRule", "意见", "owner", { subject: "#1", reason: "开始" });
  const job = h.act("claimNext", "w1", "c1");
  h.act("finish", job.run, job.token, {
    outcome: "done",
    later: [{ key: "check", at: new Date(Date.UTC(2026, 10, 5, 1)).toISOString(), about: "再看" }],
  });
  h.advance(60 * 60_000);
  h.act("tick");
  const timer = rows(h.view(), "events", { type: "timer.due" })[0];
  const decision = rows(h.view(), "decisions", { event_id: timer.id, rule: "意见" });
  assert.deepEqual(
    decision.map((d) => [d.state, d.reason]),
    [["accept", "timer"]],
  );
  assert.ok(rows(h.view(), "mandates").some((m) => m.event_id === timer.id && m.reason === "timer"));
});

test("a schedule tick and a manual run each leave one decision", () => {
  const h = hub();
  // The first tick only seeds the schedules; the next due moment is what starts a round.
  h.act("tick");
  h.advance(10 * 60_000);
  h.act("tick");
  const tick = rows(h.view(), "events", { type: "schedule.tick" })[0];
  assert.deepEqual(
    rows(h.view(), "decisions", { event_id: tick.id }).map((d) => d.reason),
    ["schedule"],
  );
  h.act("runRule", "意见", "owner", { subject: "#1", reason: "手动" });
  const manual = rows(h.view(), "events", { type: "run.manual" })[0];
  assert.deepEqual(
    rows(h.view(), "decisions", { event_id: manual.id }).map((d) => d.reason),
    ["manual"],
  );
});

test("an external event with a gate decision is not given a second one on dispatch", () => {
  const h = hub({
    sources: { ...base.sources, app: { name: "应用", policy: { allowlist: ["alice"] } } },
    policy: { accept: "gate" },
  });
  const ack = h.send({ actor: "alice" });
  assert.equal(rows(h.view(), "decisions", { event_id: ack.event, rule: "意见" }).length, 1);
});

test("a person's answer leaves a decision but is not fanned out as material for other matters", () => {
  const other = {
    name: "同一对象另一件事",
    when: { source: "ops", types: ["alert.raised"] },
    to: "a1",
    cwd: "~/x",
    prompt: "也看看。",
    group: "same",
    parallel: 3,
  };
  const h = hub({ policy: { accept: "gate", fanout: true }, rules: [...base.rules, other] });
  h.send({ subject: "#9", type: "feedback.new", actor: "alice" });
  h.send({ subject: "#9", type: "alert.raised", actor: "alice" }, "ops");
  const first = h.act("claimNext", "w1", "c1");
  assert.equal(first.rule.name, "意见");
  h.act("finish", first.run, first.token, {
    outcome: "done",
    ask: [{ title: "要不要继续", text: "现在停在这里", options: ["继续", "停"] }],
  });
  const card = rows(h.view(), "cards", { state: "open" })[0];
  h.act("answer", card.id, { choice: 0, by: "me" });
  const answered = rows(h.view(), "events", { type: "card.answered" })[0];
  assert.deepEqual(
    rows(h.view(), "decisions", { event_id: answered.id, rule: "意见" }).map((d) => d.reason),
    ["person"],
  );
  const otherMatter = rows(h.view(), "runs", { rule: "同一对象另一件事", lane: "#9" })[0];
  assert.ok(
    !rows(h.view(), "run_events", { run_id: otherMatter.id, event_id: answered.id }).length,
    "a private answer stays with the matter it answers",
  );
});
