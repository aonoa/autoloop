// What an open matter is waiting for, read from the rounds and cards already recorded. It decides nothing: a person's
// board, a card and a resume all read the same stage, so they agree on whether work can go on without a person.
import { rows, type Row, type View } from "./evolve.ts";
import { ruleOf, type Rules } from "./rules.ts";

export type Stage =
  | "person/delivery"
  | "person/answer"
  | "person/review"
  | "person/blocked"
  | "person/failed"
  | "working/queued"
  | "idle"
  | "working";

/** The latest round of a matter, which is what its stage is read from. */
export function latestRun(view: View, rule: string, lane: string): Row | undefined {
  return rows(view, "runs", { rule, lane }, 1, true)[0];
}

/** Whether a person acted on the matter since the latest round, which releases a `blocked` or `failed` one. */
export function releasedByPerson(view: View, rule: string, lane: string): boolean {
  const latest = latestRun(view, rule, lane);
  if (!latest?.finished_at) return false;
  const after = (at: string | null | undefined) => !!at && Date.parse(at) > Date.parse(latest.finished_at);
  // Only a person's answer or closing releases it: an automatic event is recorded but does not count. A round closing a
  // card through its receipt writes "第 N 轮" there, which is not a person.
  return rows(view, "cards", { rule, lane, state: ["decided", "done", "closed"] }).some(
    (card) => after(card.decided_at) || (!!card.by && !/^第 \d+ 轮$/.test(card.by) && after(card.closed_at)),
  );
}

/** A round's structured report, when it left one; older receipts have none. */
export function reportOf(run: Row | undefined): { state: string; note?: string } | null {
  if (!run?.report) return null;
  try {
    return JSON.parse(run.report);
  } catch {
    return null;
  }
}

/**
 * The stage table, read from the top; the first matching row wins. A `person` stage means the matter cannot go on until a
 * person acts. A new person's message releases `blocked`/`failed`, so the matter moves to its next matching stage.
 */
export function stageOf(view: View, rules: Rules, rule: string, lane: string, now: number): Stage {
  const latest = latestRun(view, rule, lane);
  const report = reportOf(latest);
  // A card whose latest send failed and is waiting to try again is a delivery problem, before anything it asks.
  // A card already answered or closed no longer waits for its message to arrive.
  const undelivered = rows(view, "cards", { rule, lane, state: "open" })
    .flatMap((card) => rows(view, "deliveries", { card_id: card.id }))
    .some(
      (delivery) =>
        delivery.error && !delivery.given_up && delivery.not_before && Date.parse(delivery.not_before) > now,
    );
  if (undelivered) return "person/delivery";
  const open = rows(view, "cards", { rule, lane, state: "open" });
  if (open.some((card) => card.kind === "ask")) return "person/answer";
  if (report?.state === "ready") return "person/review";
  // A person's message since that report is what lets the matter go on; until then it waits for one.
  const released = releasedByPerson(view, rule, lane);
  if (report?.state === "blocked" && !released) return "person/blocked";
  if (report?.state === "failed" && !released) return "person/failed";
  const definition = ruleOf(rules, rule);
  if (!definition) return "idle";
  const queued = rows(view, "runs", { rule, lane, state: "queued" });
  if (queued.length) return "working/queued";
  if (!latest) return "working/queued";
  if (latest.state === "claimed" || latest.state === "unknown") return "working";
  if (report?.state === "progress") return "working";
  if (report?.state === "waiting") return "idle";
  return "idle";
}

/** Whether a matter is still live: it has work, a question, a timer, or a report a person has not settled. */
function live(view: View, rule: string, lane: string, now: number): boolean {
  if (rows(view, "runs", { rule, lane, state: ["queued", "claimed", "unknown"] }).length) return true;
  if (rows(view, "cards", { rule, lane, state: "open" }).length) return true;
  if (rows(view, "timers", { rule, lane, event_id: null }).some((timer) => Date.parse(timer.at) > now)) return true;
  const report = reportOf(latestRun(view, rule, lane));
  return !!report && !["waiting", "dropped"].includes(report.state);
}

/** Every live matter with its stage, newest first: the board a person reads. */
export function stagesOf(view: View, rules: Rules, now: number) {
  const matters = new Map<string, { rule: string; lane: string; last: number }>();
  for (const run of rows(view, "runs")) {
    const key = `${run.rule}:${run.lane}`;
    const seen = matters.get(key);
    if (!seen || run.id > seen.last) matters.set(key, { rule: run.rule, lane: run.lane, last: run.id });
  }
  return [...matters.values()]
    .filter((matter) => live(view, matter.rule, matter.lane, now))
    .map((matter) => {
      const definition = ruleOf(rules, matter.rule);
      return {
        ...matter,
        ...(definition?.project && { project: definition.project }),
        stage: stageOf(view, rules, matter.rule, matter.lane, now),
      };
    })
    .sort((a, b) => b.last - a.last);
}
