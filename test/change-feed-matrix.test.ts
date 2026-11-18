/** Change-feed model: replay failures with the printed seed and sequence. */
import { expect, test } from "bun:test";
import { Database, z } from "../src/index";
import { Database as BareSqlite } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schema = { notes: z.object({ text: z.string(), n: z.number().default(0) }) };
type Event = { op: "insert" | "update" | "delete"; table: string; id: number };
const options = { pollInterval: 5 };
const make = (file = ":memory:", extra: Record<string, any> = {}) =>
  new Database(file, schema, { ...options, ...extra });
function listen(db: any, seen: Event[], table = "notes") {
  return (["insert", "update", "delete"] as const).map((op) =>
    (db as any)[table].on(op, (row: any) => seen.push({ op, table, id: row.id })));
}
function drain(db: any) {
  // Explicit tick enables zero-event assertions without sleeps or timer races.
  (db as any)._processChanges();
}
async function untilCount(items: unknown[], count: number, timeout = 1500) {
  const end = Date.now() + timeout;
  while (items.length < count && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(items.length).toBe(count);
}
function withFile(fn: (path: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "orm-feed-"));
  return Promise.resolve().then(() => fn(join(dir, "state.sqlite"))).finally(() =>
    rmSync(dir, { recursive: true, force: true }));
}

// The minimal pre-fix regression: A prunes a write while B has not polled.
test("regression: separate readers never steal each other's unconsumed changes", () => withFile((path) => {
  const a = make(path), b = make(path);
  const sa: Event[] = [], sb: Event[] = [];
  const stops = [...listen(a, sa), ...listen(b, sb)];
  try {
    const row = a.notes.insert({ text: "from-a" });
    drain(a);
    drain(b);
    const expected: Event[] = [{ op: "insert", table: "notes", id: row.id }];
    expect(sa).toEqual(expected);
    expect(sb).toEqual(expected);
    b.notes.update(row.id, { text: "from-b" });
    drain(b);
    drain(a);
    expected.push({ op: "update", table: "notes", id: row.id });
    expect(sa).toEqual(expected);
    expect(sb).toEqual(expected);
    drain(a); drain(b);
    expect(sa).toEqual(expected);
    expect(sb).toEqual(expected);
  } finally { stops.forEach((off) => off()); a.close(); b.close(); }
}));

test("regression: insert then hard-delete before polling reports both ids in order", () => {
  const db = make(); const got: Event[] = []; const off = listen(db, got);
  try {
    const row = db.notes.insert({ text: "ephemeral" });
    db.notes.delete(row.id);
    drain(db);
    expect(got).toEqual([
      { op: "insert", table: "notes", id: row.id },
      { op: "delete", table: "notes", id: row.id },
    ]);
  } finally { off.forEach((f) => f()); db.close(); }
});

test("regression: late subscription does not replay earlier pending changes", () => {
  const db = make(); const early: Event[] = []; const late: Event[] = [];
  const off = listen(db, early);
  try {
    const a = db.notes.insert({ text: "before" });
    const offLate = listen(db, late);
    const b = db.notes.insert({ text: "after" });
    drain(db);
    expect(early).toEqual([a, b].map((r) => ({ op: "insert", table: "notes", id: r.id })));
    expect(late).toEqual([{ op: "insert", table: "notes", id: b.id }]);
    offLate.forEach((f) => f());
  } finally { off.forEach((f) => f()); db.close(); }
});

test("rollback, nested savepoints, and raw SQL: only committed changes", () => {
  const db = make(); const seen: Event[] = []; const off = listen(db, seen);
  try {
    const first = db.notes.insert({ text: "first" });
    expect(() => db.transaction(() => {
      db.notes.insert({ text: "abort" });
      throw new Error("rollback");
    })).toThrow("rollback");
    db.transaction(() => {
      db.notes.update(first.id, { n: 3 });
      try { db.transaction(() => { db.notes.delete(first.id); throw new Error("savepoint"); }); }
      catch (error) { expect(String(error)).toContain("savepoint"); }
      db.exec('INSERT INTO "notes" ("text", "n") VALUES (?, ?)', "raw", 2);
    });
    const rawId = (db.raw<{ id: number }>('SELECT id FROM "notes" WHERE text = ?', "raw"))[0]!.id;
    drain(db);
    expect(seen).toEqual([
      { op: "insert", table: "notes", id: first.id },
      { op: "update", table: "notes", id: first.id },
      { op: "insert", table: "notes", id: rawId },
    ]);
  } finally { off.forEach((f) => f()); db.close(); }
});

test("bulk, partial update, upsert branches, and fluent delete report physical row writes", () => {
  const db = make(); const seen: Event[] = []; const off = listen(db, seen);
  try {
    const a = db.notes.insert({ text: "A" });
    const b = db.notes.insert({ text: "B" });
    db.notes.update(a.id, { n: 1 });
    db.notes.update({ n: 2 }).where({ id: { $gte: a.id, $lte: b.id } }).exec();
    db.notes.upsert({ text: "A" }, { text: "A2" }); // condition match -> update
    db.notes.upsert({ text: "C" }, { text: "C" });  // condition absent -> insert
    const c = db.raw<{ id: number }>('SELECT id FROM notes WHERE text = ?', "C")[0]!.id;
    db.notes.delete().where({ id: { $gte: b.id, $lte: c } }).exec();
    drain(db);
    expect(seen).toEqual([
      ...[a.id, b.id].map((id) => ({ op: "insert" as const, table: "notes", id })),
      { op: "update", table: "notes", id: a.id },
      ...[a.id, b.id].map((id) => ({ op: "update" as const, table: "notes", id })),
      { op: "update", table: "notes", id: a.id },
      { op: "insert", table: "notes", id: c },
      ...[b.id, c].map((id) => ({ op: "delete" as const, table: "notes", id })),
    ]);
  } finally { off.forEach((f) => f()); db.close(); }
});

test("multiple listeners, reentrancy, thrown listener and removal while dispatching", () => {
  const db = make(); const seen: string[] = [];
  const error = console.error;
  console.error = () => {};
  let stopB = () => {};
  const offA = db.notes.on("insert", (r) => {
    seen.push(`A:${r.id}`);
    stopB();
    if (r.text === "root") db.notes.insert({ text: "child" });
  });
  stopB = db.notes.on("insert", () => { seen.push("B"); });
  const offC = db.notes.on("insert", () => { throw new Error("handled"); });
  try {
    db.notes.insert({ text: "root" });
    drain(db); drain(db);
    expect(seen).toEqual(["A:1", "A:2"]);
  } finally { offA(); stopB(); offC(); console.error = error; db.close(); }
});

test("timer polls automatically and unsubscribing prevents later notifications", async () => {
  const db = make(); const seen: Event[] = []; const off = listen(db, seen);
  try {
    const a = db.notes.insert({ text: "timer" });
    await untilCount(seen, 1);
    expect(seen).toEqual([{ op: "insert", table: "notes", id: a.id }]);
    off.forEach((f) => f());
    db.notes.insert({ text: "no listener" });
    drain(db);
    expect(seen).toHaveLength(1);
  } finally { off.forEach((f) => f()); db.close(); }
});

test("plain bun:sqlite writes are seen by both ORM connections", () => withFile((path) => {
  const a = make(path), b = make(path), plain = new BareSqlite(path);
  const x: Event[] = [], y: Event[] = [];
  const off = [...listen(a, x), ...listen(b, y)];
  try {
    plain.exec('INSERT INTO "notes" ("text", "n") VALUES (\'direct\', 5)');
    const id = (plain.query('SELECT id FROM "notes" WHERE text = ?').get("direct") as { id: number }).id;
    drain(a); drain(b);
    const expected: Event[] = [{ op: "insert", table: "notes", id }];
    expect(x).toEqual(expected); expect(y).toEqual(expected);
  } finally { off.forEach((f) => f()); plain.close(); a.close(); b.close(); }
}));

test("reactive false rejects listeners without affecting ordinary writes", () => {
  const db = make(":memory:", { reactive: false });
  try {
    db.notes.insert({ text: "plain" });
    expect(() => db.notes.on("insert", () => {})).toThrow(/disabled/);
    expect(db.raw<{ n: number }>('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?', '_changes')[0]!.n).toBe(0);
  } finally { db.close(); }
});

test("soft delete and restore dispatch UPDATE events even for hidden rows", () => {
  const db = make(":memory:", { softDeletes: true });
  const got: Event[] = []; const off = listen(db, got);
  try {
    const row = db.notes.insert({ text: "soft" });
    db.notes.delete(row.id); db.notes.restore(row.id);
    drain(db);
    expect(got).toEqual([
      { op: "insert", table: "notes", id: row.id },
      { op: "update", table: "notes", id: row.id },
      { op: "update", table: "notes", id: row.id },
    ]);
    db.notes.delete(row.id); drain(db);
    expect(got.at(-1)).toEqual({ op: "update", table: "notes", id: row.id });
  } finally { off.forEach((f) => f()); db.close(); }
});

test("close/reopen skips historical events but receives new writes", () => withFile((path) => {
  const old = make(path); const got: Event[] = []; const off = listen(old, got);
  old.notes.insert({ text: "old" }); drain(old); off.forEach((f) => f()); old.close();
  const fresh = make(path); const later: Event[] = []; const stop = listen(fresh, later);
  try {
    drain(fresh); expect(later).toEqual([]);
    const row = fresh.notes.insert({ text: "new" }); drain(fresh);
    expect(later).toEqual([{ op: "insert", table: "notes", id: row.id }]);
  } finally { stop.forEach((f) => f()); fresh.close(); }
}));

test("4,096 deterministic seeded sequences: compare exact event order/count after every step", () => {
  const db = make(); const seen: Event[] = []; const off = listen(db, seen);
  const expected: Event[] = [];
  let state = 0x7b4f91da;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const trace: string[] = [];
  try {
    for (let seed = 0; seed < 4096; seed++) {
      trace.length = 0;
      const kind = next() % 5;
      const a = db.notes.insert({ text: `seed-${seed}` });
      trace.push(`insert(${a.id})`);
      expected.push({ op: "insert", table: "notes", id: a.id });
      if (kind === 0) { db.notes.update(a.id, { n: seed }); trace.push(`update(${a.id})`); expected.push({ op: "update", table: "notes", id: a.id }); }
      if (kind === 1) { db.notes.delete(a.id); trace.push(`delete(${a.id})`); expected.push({ op: "delete", table: "notes", id: a.id }); }
      if (kind === 2) { db.notes.update({ n: seed }).where({ id: a.id }).exec(); trace.push(`bulkUpdate(${a.id})`); expected.push({ op: "update", table: "notes", id: a.id }); }
      if (kind === 3) { db.exec('UPDATE "notes" SET "n" = ? WHERE id = ?', seed, a.id); trace.push(`rawUpdate(${a.id})`); expected.push({ op: "update", table: "notes", id: a.id }); }
      if (kind === 4) { try { db.transaction(() => { db.notes.delete(a.id); throw Error("rollback"); }); } catch {} trace.push(`rollbackDelete(${a.id})`); }
      drain(db);
      // In case of failure the assertion identifies the seed and shortest
      // operation suffix to replay; each sequence is at most two operations.
      const newEvents = expected.slice(expected.length - (kind === 4 ? 1 : 2));
      const actualEvents = seen.slice(seen.length - newEvents.length);
      if (seen.length !== expected.length || JSON.stringify(actualEvents) !== JSON.stringify(newEvents)) {
        throw new Error(`seed=${seed} sequence=${trace.join(' -> ')} expectedTail=${JSON.stringify(expected.slice(-3))} actualTail=${JSON.stringify(seen.slice(-3))}`);
      }
    }
    expect(seen).toEqual(expected);
  } finally { off.forEach((f) => f()); db.close(); }
});


test("hard and soft cascades: descendants each emit a single physical event", () => {
  for (const softDeletes of [false, true]) {
    const db = new Database(":memory:", {
      parents: z.object({ text: z.string() }),
      children: z.object({ parent_id: z.number().nullable() }),
      grandchildren: z.object({ child_id: z.number().nullable() }),
    }, { pollInterval: 5, softDeletes,
      relations: { children: { parent_id: "parents" }, grandchildren: { child_id: "children" } },
      cascade: { parents: ["children"], children: ["grandchildren"] },
    });
    const seen: Event[] = [];
    const stops = ["parents", "children", "grandchildren"].flatMap((t) =>
      (["insert", "update", "delete"] as const).map((op) =>
        (db as any)[t].on(op, (row: any) => seen.push({ op, table: t, id: row.id }))));
    try {
      const p = db.parents.insert({ text: "p" });
      const c = db.children.insert({ parent_id: p.id });
      const g = db.grandchildren.insert({ child_id: c.id });
      drain(db);
      const inserts: Event[] = [
        { op: "insert", table: "parents", id: p.id },
        { op: "insert", table: "children", id: c.id },
        { op: "insert", table: "grandchildren", id: g.id },
      ];
      expect(seen).toEqual(inserts);
      db.parents.delete(p.id);
      drain(db);
      const op = softDeletes ? "update" : "delete";
      // Cascade visits descendants before deleting the parent.
      expect(seen).toEqual([...inserts,
        { op, table: "grandchildren", id: g.id },
        { op, table: "children", id: c.id },
        { op, table: "parents", id: p.id },
      ]);
      if (softDeletes) {
        db.parents.restore(p.id);
        drain(db);
        expect(seen.slice(6).map(({ op, table, id }) => ({ op, table, id })))
          .toEqual([
            { op: "update", table: "parents", id: p.id },
            { op: "update", table: "children", id: c.id },
            { op: "update", table: "grandchildren", id: g.id },
          ]);
      }
    } finally { stops.forEach((f) => f()); db.close(); }
  }
});

test("hook-triggered writes to another table preserve statement event order", () => {
  let db: any;
  db = new Database(":memory:", {
    notes: schema.notes,
    audit: z.object({ text: z.string() }),
  }, { pollInterval: 5, hooks: {
    notes: { afterInsert: () => db.audit.insert({ text: "from hook" }) },
  } });
  const seen: Event[] = [];
  const stops = ["notes", "audit"].flatMap((t) =>
    (["insert", "update", "delete"] as const).map((op) =>
      db[t].on(op, (row: any) => seen.push({ op, table: t, id: row.id }))));
  try {
    const n = db.notes.insert({ text: "source" });
    drain(db);
    expect(seen).toEqual([
      { op: "insert", table: "notes", id: n.id },
      { op: "insert", table: "audit", id: 1 },
    ]);
  } finally { stops.forEach((f: () => void) => f()); db.close(); }
});

test("reconstructive migration retains triggers but does not replay copied rows", () => withFile((path) => {
  const first = new Database(path, { notes: z.object({ text: z.string() }) }, options);
  first.notes.insert({ text: "before" });
  first.close();
  const upgraded = new Database(path, {
    notes: z.object({ text: z.string(), extra: z.number().default(4) }),
  }, options);
  const seen: Event[] = [];
  const stops = listen(upgraded as any, seen);
  try {
    drain(upgraded as any);
    expect(seen).toEqual([]);
    const row = upgraded.notes.insert({ text: "after", extra: 7 });
    drain(upgraded as any);
    expect(seen).toEqual([{ op: "insert", table: "notes", id: row.id }]);
    expect(upgraded.raw<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='notes'`)[0]!.n).toBe(3);
  } finally { stops.forEach((f) => f()); upgraded.close(); }
}));

test("consuming changes does not discard another reader's backlog", () => withFile((path) => {
  const a = make(path), b = make(path);
  const seen: Event[] = [], delayed: Event[] = [];
  const stops = [...listen(a, seen), ...listen(b, delayed)];
  try {
    for (let i = 0; i < 120; i++) {
      a.notes.insert({ text: `item-${i}` });
      if (i % 7 === 0) drain(a);
    }
    drain(a); drain(b);
    expect(seen).toHaveLength(120);
    expect(delayed).toEqual(seen);
    expect(a.raw<{ n: number }>('SELECT COUNT(*) AS n FROM "_changes"')[0]!.n).toBe(120);
  } finally { stops.forEach((f) => f()); a.close(); b.close(); }
}));

test("table names containing SQL quoting characters still produce valid change triggers", () => {
  const db = new Database(":memory:", { "odd'\"notes": z.object({ text: z.string() }) }, options);
  const seen: Event[] = [];
  const table = "odd'\"notes";
  const stops = (["insert", "update", "delete"] as const).map((op) =>
    (db as any)[table].on(op, (row: any) => seen.push({ op, table, id: row.id })));
  try {
    const row = (db as any)[table].insert({ text: "ok" });
    drain(db as any);
    expect(seen).toEqual([{ op: "insert", table, id: row.id }]);
  } finally { stops.forEach((f) => f()); db.close(); }
});


test("upsert revival of a soft-deleted row emits restoration and update operations", () => {
  const db = make(":memory:", { softDeletes: true });
  const seen: Event[] = []; const stops = listen(db, seen);
  try {
    const row = db.notes.insert({ text: "key" });
    db.notes.delete(row.id);
    // The two-argument upsert matches a hidden row by condition, restores it,
    // then updates its supplied data within the same committed transaction.
    db.notes.upsert({ text: "key" }, { n: 8 });
    drain(db);
    expect(seen).toEqual([
      { op: "insert", table: "notes", id: row.id },
      { op: "update", table: "notes", id: row.id },
      { op: "update", table: "notes", id: row.id },
      { op: "update", table: "notes", id: row.id },
    ]);
    expect(db.notes.get(row.id)?.n).toBe(8);
  } finally { stops.forEach((f) => f()); db.close(); }
});

test("insertMany, write-through entity assignment, and bulk SQL delete remain ordered", () => {
  const db = make(); const seen: Event[] = []; const stops = listen(db, seen);
  try {
    const [a, b] = db.notes.insertMany([{ text: "one" }, { text: "two" }]);
    a!.n = 12;
    db.notes.delete().where({ id: b!.id }).exec();
    drain(db);
    expect(seen).toEqual([
      { op: "insert", table: "notes", id: a!.id },
      { op: "insert", table: "notes", id: b!.id },
      { op: "update", table: "notes", id: a!.id },
      { op: "delete", table: "notes", id: b!.id },
    ]);
  } finally { stops.forEach((f) => f()); db.close(); }
});

test("journal keeps a 10,000-change window for other readers and trims older rows", () => withFile((path) => {
  const a = make(path), b = make(path);
  const seen: Event[] = [], delayed: Event[] = [];
  const stops = [...listen(a, seen), ...listen(b, delayed)];
  try {
    a.transaction(() => { for (let i = 0; i < 10_050; i++) a.notes.insert({ text: `bulk-${i}` }); });
    drain(a);
    const count = () => a.raw<{ n: number }>('SELECT COUNT(*) AS n FROM "_changes"')[0]!.n;
    expect(count()).toBe(10_000);
    // b fell 10,050 writes behind: it gets the newest 10,000, in order.
    drain(b);
    expect(delayed).toHaveLength(10_000);
    expect(delayed).toEqual(seen.slice(50));
    // Reopening also trims, without listeners.
    for (let i = 0; i < 30; i++) a.notes.insert({ text: `more-${i}` });
    const c = make(path);
    expect(count()).toBe(10_000);
    c.close();
  } finally { stops.forEach((f) => f()); a.close(); b.close(); }
}));
