// `compact`: drop the facts that only say "still here". A worker with work in hand asks every second and a channel polls
// all day; each of those facts is a disk sync, and they're most of a long-lived hub's log while carrying nothing but the
// newest stamp on a handful of rows.
//
// What comes out must be the same state, so the rule is per row rather than per fact: for every row a stamp wrote, the
// newest stamp that wrote it stays. A stamp that *removed* a row stays too, however old: dropping it would put that row
// back. Age is a floor on what may be trimmed, never a reason to take something newer. The projection is rebuilt from what
// is left and compared with what it was, so a mistake here rolls back instead of quietly changing the hub's state.
//
// It needs the log to itself. The hub keeps a view of the log in memory and appends to it from another process, so a trim
// between its read and its write would lose that fact, and VACUUM wants exclusive access besides. The hub is asked to be
// stopped, as `restore` asks; nothing here touches a running hub's files behind its back.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cardHash } from "../kernel/credentials.ts";
import { statement } from "../kernel/evolve.ts";
import { rebuild } from "../kernel/store.ts";
import { inUse } from "./backup.ts";

const DB = "hub.db";
const KEY = "master.key";
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// host/runtime.ts makes this index and rebuild doesn't; VACUUM rebuilds it, so the function has to be here.
const CARD_HASH_INDEX =
  "CREATE INDEX IF NOT EXISTS projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'";

/** The kinds whose whole content is a fresh stamp on rows that other facts write too. */
export const STAMPS = ["heartbeat", "channelSeen"];
/** Rows no trim may take: keys are credentials, and the rest are the owner's own decisions, not stamps. */
const PROTECTED = new Set(["keys", "config", "dispatch_preferences", "mandates", "decisions"]);

const DAY = 24 * 60 * 60_000;
/** A fortnight, the same window the worker keeps of its finished runs, so one answer covers both. */
export const KEEP_DAYS = 14;

export type Fact = {
  seq: number;
  at: number;
  type?: string;
  changes?: { table: string; key: string; row: unknown }[];
};

/** The rows a stamp wrote, and whether it removed any: `null` when the fact isn't a stamp or touched nothing. */
export function stamped(fact: Fact): { rows: string[]; removes: string[] } | null {
  if (!STAMPS.includes(fact.type ?? "")) return null;
  const rows: string[] = [];
  const removes: string[] = [];
  for (const change of fact.changes ?? []) {
    if (PROTECTED.has(change.table)) return null;
    const row = `${change.table}\u0000${change.key}`;
    if (change.row === null) removes.push(row);
    else rows.push(row);
  }
  if (!rows.length && !removes.length) return null;
  return { rows, removes };
}

/**
 * Which facts to drop: stamps written before `older` whose every row some later fact touches. The seqs to delete.
 *
 * Coverage counts every fact, not just stamps: whatever writes or removes a row last decides what it looks like, and a
 * stamp before that last touch can go whatever its kind. It also has to cover *every* row the stamp touched, since one
 * fact carries a worker's stamp and the runs it still has in hand together.
 */
export function trimmable(facts: Iterable<Fact>, older: number): number[] {
  const all = [...facts];
  const lastTouch = new Map<string, number>();
  for (const fact of all) {
    for (const change of fact.changes ?? []) lastTouch.set(`${change.table}\u0000${change.key}`, fact.seq);
  }
  const drop: number[] = [];
  for (const fact of all) {
    if (fact.at >= older) continue;
    const stamp = stamped(fact);
    if (!stamp) continue;
    const touched = [...stamp.rows, ...stamp.removes];
    if (touched.every((row) => (lastTouch.get(row) ?? 0) > fact.seq)) drop.push(fact.seq);
  }
  return drop;
}

export type Compacted = { dropped: number; left: number; before: number; after: number; vacuumed: boolean };

/** Reads the log, drops the stamps nothing newer needs, rebuilds and gives the pages back. The hub must be stopped. */
export function compact(home: string, { keepDays = KEEP_DAYS, now = Date.now() } = {}): Compacted {
  if (!Number.isInteger(keepDays) || keepDays < 0) throw new Error("--keep-days 要是大于等于 0 的整数");
  const file = path.join(home, DB);
  if (!existsSync(file)) throw new Error(`没有 ${file}：还没装好，先运行 agent-autoloop init`);
  if (inUse(file)) throw new Error("中台还在跑：先停掉它（例如 agent-autoloop service remove），再压缩");
  const keyFile = path.join(home, KEY);
  if (!existsSync(keyFile)) throw new Error(`缺 ${KEY}：重建投影要用它算卡片链接的索引`);
  const secret = readFileSync(keyFile, "utf8").trim();
  if (!KEY_SHAPE.test(secret)) throw new Error(`${KEY} 坏了（应该是 43 个字符）：先从备份恢复它，再压缩`);

  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    // What's owed to the WAL isn't in the file yet: fold it in, so the sizes below are the sizes on disk.
    const settle = () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return statSync(file).size;
    };
    const original = settle();
    db.function("card_hash", { deterministic: true }, (id, at) => cardHash({ secret, publicUrl: "" }, id, at));
    const meta = db.prepare("SELECT format FROM projection_meta WHERE id=1").get() as { format: string } | undefined;
    const facts: Fact[] = db
      .prepare("SELECT seq, fact FROM facts ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String((row as { fact: string }).fact)) as Fact);
    const drop = trimmable(facts, now - keepDays * DAY);
    if (!drop.length) return { dropped: 0, left: facts.length, before: original, after: original, vacuumed: true };
    const rows = () => db.prepare("SELECT collection, key, data FROM projections ORDER BY collection, key").all();
    const was = JSON.stringify(rows());

    db.exec("BEGIN IMMEDIATE");
    try {
      const gone = statement(db, "DELETE FROM facts WHERE seq=?");
      const ref = statement(db, "DELETE FROM projection_refs WHERE seq=?");
      for (const seq of drop) {
        gone.run(seq);
        ref.run(seq);
      }
      // A rebuild is also the check: `why` follows projection_refs, and the state has to come out the same.
      rebuild(db, meta?.format ?? "");
      db.exec(CARD_HASH_INDEX);
      if (JSON.stringify(rows()) !== was) throw new Error("压缩会改变中台的状态，已经回滚，什么都没删");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    let vacuumed = true;
    try {
      db.exec("VACUUM");
    } catch (error) {
      // The pages are the only thing left; the log is already tidied, and that is the part that matters.
      vacuumed = false;
      console.error(`记录整理好了，回收空间没成功：${error}`);
    }
    return {
      dropped: drop.length,
      left: Number(db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n),
      before: original,
      after: settle(),
      vacuumed,
    };
  } finally {
    db.close();
  }
}
