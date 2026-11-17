// `compact` drops the facts that only say "still here". Failure modes: the newest stamp of a row goes, so a worker or
// channel that is there reads as gone, or a run in hand goes in doubt; a stamp that removed a row goes, putting the row
// back; a stamp newer than the window goes; a stamp that also carried a real change goes with its stamp, losing that
// change; the projection is left stale, so a start replays the trimmed log onto a different state; projection_refs keeps
// pointing at deleted facts, so `why` throws; the state isn't compared before the trim is kept, so a wrong rule changes
// the hub silently; the file isn't given back to the filesystem; the card_hash index isn't put back after a rebuild;
// credentials or the owner's own decisions are taken; a hub still running isn't refused; the log is empty, or has nothing
// to drop, and that is an error instead of a no-op.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("compact");
const hub = await import("./hub.ts");
const { compact, trimmable, stamped, KEEP_DAYS } = await import("../cli/compact.ts");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const start = Date.parse("2026-11-10T02:00:00.000Z");
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-compact-"));
after(() => {
  if (hub.db.isOpen) hub.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const stamp = (seq: number, at: number, ...rows: [string, string][]) => ({
  seq,
  at,
  type: "heartbeat",
  changes: rows.map(([table, key]) => ({ table, key, row: { seen_at: new Date(at).toISOString() } })),
});
const removal = (seq: number, at: number, table: string, key: string) => ({
  seq,
  at,
  type: "channelSeen",
  changes: [{ table, key, row: null }],
});
const other = (seq: number, at: number, type = "finish") => ({
  seq,
  at,
  type,
  changes: [{ table: "runs", key: "1", row: { state: type } }],
});

test("only stamps are candidates, and only the ones a newer stamp covers", () => {
  const facts = [
    stamp(1, start, ["seen", "worker:w1"]),
    stamp(2, start + MINUTE, ["seen", "worker:w1"]),
    stamp(3, start + 2 * MINUTE, ["seen", "worker:w1"]),
    other(4, start + 3 * MINUTE),
  ];
  // The newest stamp of each row stays; the older stamps of that same row go.
  assert.deepEqual(trimmable(facts, start + DAY), [1, 2]);
  // Nothing older than the window: the newest stamp of the row is outside it, and takes the rest with it.
  assert.deepEqual(trimmable(facts, start + MINUTE), [1]);
  assert.deepEqual(trimmable(facts, start), []);
});

test("a stamp that removed a row stays however old it is", () => {
  const facts = [
    removal(1, start, "seen", "worker:w1"),
    stamp(2, start + MINUTE, ["seen", "worker:w2"]),
    stamp(3, start + 2 * MINUTE, ["seen", "worker:w2"]),
  ];
  // Dropping the removal would put worker:w1 back in the projection.
  assert.deepEqual(trimmable(facts, start + DAY), [2]);
});

test("a stamp kept for one row takes the other rows it wrote with it", () => {
  // The same fact stamps a worker and renews a run in hand: dropping it would leave the run looking quiet.
  const both = stamp(1, start, ["seen", "worker:w1"], ["runs", "7"]);
  const facts = [both, stamp(2, start + MINUTE, ["seen", "worker:w1"])];
  assert.deepEqual(trimmable(facts, start + DAY), []);
});

test("credentials and the owner's own decisions are never candidates", () => {
  const key = { seq: 1, at: start, type: "heartbeat", changes: [{ table: "keys", key: "worker:w1", row: {} }] };
  const decided = { seq: 2, at: start, type: "channelSeen", changes: [{ table: "decisions", key: "1", row: {} }] };
  assert.equal(stamped(key), null);
  assert.equal(stamped(decided), null);
  assert.equal(stamped(other(1, start)), null, "not a stamp at all");
});

/** A home with a hub.db holding `n` stamps a minute apart, and a master.key beside it. */
function filled(n: number, secret = "k".repeat(43)): string {
  const where = mkdtempSync(join(scratch, "home-"));
  const db = new DatabaseSync(join(where, "hub.db"));
  db.exec(
    "CREATE TABLE facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL);" +
      "CREATE TABLE projections(collection TEXT,key TEXT,data TEXT NOT NULL,PRIMARY KEY(collection,key));" +
      "CREATE TABLE projection_meta(id INTEGER PRIMARY KEY,seq INTEGER NOT NULL,next TEXT NOT NULL,format TEXT NOT NULL);" +
      "CREATE TABLE projection_refs(collection TEXT,key TEXT,seq INTEGER,PRIMARY KEY(collection,key,seq));" +
      "CREATE TABLE projection_pending(key TEXT PRIMARY KEY,card_id INTEGER,channel TEXT);",
  );
  const insert = db.prepare("INSERT INTO facts VALUES (?,?)");
  for (let i = 1; i <= n; i++) insert.run(i, JSON.stringify(stamp(i, start + i * MINUTE, ["seen", "worker:w1"])));
  db.close();
  writeFileSync(join(where, "master.key"), `${secret}\n`, { mode: 0o600 });
  return where;
}

const count = (where: string) => {
  const db = new DatabaseSync(join(where, "hub.db"), { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n);
  } finally {
    db.close();
  }
};

test("stamps inside the window stay, and nothing to drop is a no-op rather than an error", () => {
  const where = filled(3);
  const done = compact(where, { keepDays: KEEP_DAYS, now: start + DAY });
  assert.equal(done.dropped, 0);
  assert.equal(done.left, 3);
  assert.equal(count(where), 3);
});

test("an empty log is a no-op rather than a crash", () => {
  const where = filled(0);
  const done = compact(where, { now: start + DAY });
  assert.equal(done.dropped, 0);
  assert.equal(done.left, 0);
});

test("a hub still holding the database is refused", () => {
  const where = filled(1);
  const holder = new DatabaseSync(join(where, "hub.db"));
  holder.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  try {
    assert.throws(() => compact(where, { now: start + DAY }), /中台还在跑/);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("a missing or broken master.key is refused before anything is deleted", () => {
  const without = filled(3);
  rmSync(join(without, "master.key"));
  assert.throws(() => compact(without, { now: start + DAY }), /master\.key/);
  assert.equal(count(without), 3, "nothing was deleted");

  const broken = filled(3, "short");
  assert.throws(() => compact(broken, { now: start + DAY }), /坏了/);
  assert.equal(count(broken), 3, "nothing was deleted");
});

test("a keep-days that isn't a whole, non-negative number of days is refused", () => {
  const where = filled(1);
  for (const keepDays of [-1, 1.5, NaN]) {
    assert.throws(() => compact(where, { keepDays, now: start + DAY }), /keep-days/);
  }
});

test("a real hub's older stamps go, the state is the same, `why` still reads, and the file shrinks", () => {
  // Work that leaves a run in hand, so the stamps that follow cover both a worker and a run.
  hub.ingest("app", { id: "compact:1", type: "feedback.new", subject: "#1" }, start);
  const job = hub.claimNext("w1", "compact-claim", start + 1000)!;
  assert.ok(job.run);
  for (let i = 0; i < 40; i++) hub.heartbeat("w1", [job.run], start + 2000 + i * MINUTE);
  hub.execute("channelSeen", ["chat"], start + 2000);
  for (let i = 0; i < 20; i++) hub.execute("channelSeen", ["chat"], start + 3000 + i * MINUTE);
  hub.finish(job.run, job.token, { outcome: "done", summary: "做完了" }, start + 60 * MINUTE);

  const where = mkdtempSync(join(scratch, "real-"));
  closeHub();
  cpSync(join(home, "hub.db"), join(where, "hub.db"));
  cpSync(join(home, "master.key"), join(where, "master.key"));

  const stamps = factsOf(where).filter((fact: any) => ["heartbeat", "channelSeen"].includes(fact.type));
  assert.ok(stamps.length > 40, `the hub logged stamps to begin with: ${stamps.length}`);
  const before = state(where);

  const done = compact(where, { keepDays: 0, now: Date.now() + DAY });
  assert.ok(done.dropped > 0, "the old stamps were dropped");
  assert.ok(done.after < done.before, `the file shrank: ${done.before} -> ${done.after}`);
  assert.ok(
    !factsOf(where).some((fact: any) => fact.type === "heartbeat" && fact.seq === stamps[0].seq),
    "the oldest stamp is gone",
  );

  // Same state, and no dangling references: the trim may not move a row or leave `why` reading nothing.
  assert.deepEqual(state(where), before);
  assert.equal(refsDangling(where), 0);
  assert.ok(hasCardHashIndex(where), "the index VACUUM rebuilds is still there");
});

/** Settles this process's hub and closes it, so its files can be copied whole and opened by another one. */
function closeHub() {
  if (!hub.db.isOpen) return;
  hub.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  hub.db.close();
}

/** Everything the hub would show, keyed, from a start on this database alone. Probing copies the file: a rebuild is a
 * write, and the thing being measured may not be changed by the measuring. */
function state(where: string) {
  const copy = mkdtempSync(join(scratch, "probe-"));
  cpSync(join(where, "hub.db"), join(copy, "hub.db"));
  cpSync(join(where, "master.key"), join(copy, "master.key"));
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { cardHash } from ${JSON.stringify(join(import.meta.dirname, "../kernel/credentials.ts"))};
    import { initialize } from ${JSON.stringify(join(import.meta.dirname, "../kernel/evolve.ts"))};
    import { rebuild } from ${JSON.stringify(join(import.meta.dirname, "../kernel/store.ts"))};
    const home = process.env.PROBE_HOME;
    const secret = readFileSync(join(home, "master.key"), "utf8").trim();
    const db = new DatabaseSync(join(home, "hub.db"));
    db.function("card_hash", { deterministic: true }, (id, at) => cardHash({ secret, publicUrl: "" }, id, at));
    initialize(db);
    rebuild(db, "");
    const rows = db.prepare("SELECT collection,key,data FROM projections ORDER BY collection,key").all();
    console.log(JSON.stringify(rows));
  `;
  return execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    {
      env: { ...process.env, PROBE_HOME: copy },
      encoding: "utf8",
    },
  );
}

function hasCardHashIndex(where: string) {
  const db = new DatabaseSync(join(where, "hub.db"), { readOnly: true });
  try {
    return Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='projection_card_hash'").get(),
    );
  } finally {
    db.close();
  }
}

function refsDangling(where: string) {
  const db = new DatabaseSync(join(where, "hub.db"), { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM projection_refs r WHERE NOT EXISTS (SELECT 1 FROM facts f WHERE f.seq=r.seq)",
        )
        .get()!.n,
    );
  } finally {
    db.close();
  }
}

function factsOf(where: string) {
  const db = new DatabaseSync(join(where, "hub.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT fact FROM facts ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String((row as any).fact)));
  } finally {
    db.close();
  }
}
