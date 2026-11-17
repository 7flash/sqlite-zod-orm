import { expect, test } from "bun:test";
import { Database, z } from "../src";

const make = (hooks?: any) => new Database(":memory:", {
  parents: z.object({ name: z.string() }),
  children: z.object({ name: z.string(), parentId: z.number() }),
  leaves: z.object({ name: z.string(), childId: z.number() }),
}, {
  softDeletes: true,
  relations: { children: { parentId: "parents" }, leaves: { childId: "children" } },
  cascade: { parents: ["children"], children: ["leaves"] }, hooks,
});
const stamp = (db: ReturnType<typeof make>, table: string, id: number) =>
  (db.raw(`SELECT "deletedAt" FROM "${table}" WHERE id = ?`, id) as any[])[0]?.deletedAt;

test("restores all cascade levels with matching tombstones and ordered hooks", () => {
  const calls: string[] = [];
  const hooks = Object.fromEntries(["parents", "children", "leaves"].map((table) =>
    [table, {
      beforeRestore: (id: number) => { calls.push(`before:${table}:${id}`); },
      afterRestore: (id: number) => { calls.push(`after:${table}:${id}`); },
    }]));
  const db = make(hooks);
  const p = db.parents.insert({ name: "p" });
  const c = db.children.insert({ name: "c", parentId: p.id });
  const l = db.leaves.insert({ name: "l", childId: c.id });
  const old = db.children.insert({ name: "old", parentId: p.id });
  db.children.delete(old.id);
  db.exec(`UPDATE "children" SET "deletedAt" = '2000-01-01' WHERE id = ${old.id}`);
  db.parents.delete(p.id);
  expect(stamp(db, "parents", p.id)).toBe(stamp(db, "children", c.id));
  expect(stamp(db, "parents", p.id)).toBe(stamp(db, "leaves", l.id));
  db.parents.restore(p.id);
  expect([stamp(db, "parents", p.id), stamp(db, "children", c.id), stamp(db, "leaves", l.id)])
    .toEqual([null, null, null]);
  expect(stamp(db, "children", old.id)).toBe("2000-01-01");
  expect(calls).toEqual([
    `before:parents:${p.id}`, `before:children:${c.id}`, `before:leaves:${l.id}`,
    `after:leaves:${l.id}`, `after:children:${c.id}`, `after:parents:${p.id}`,
  ]);
  db.parents.restore(p.id);
  expect(calls).toHaveLength(6);
});

test("does not revive an orphan; missing ids fail and absent hooks are fine", () => {
  const db = make();
  const p = db.parents.insert({ name: "p" });
  const c = db.children.insert({ name: "c", parentId: p.id });
  db.parents.delete(p.id);
  expect(() => db.children.restore(c.id)).toThrow(/parent parents/);
  expect(stamp(db, "children", c.id)).not.toBeNull();
  expect(() => db.parents.restore(9999)).toThrow(/row not found/);
  db.parents.restore(p.id);
  expect(stamp(db, "children", c.id)).toBeNull();
});

test("a descendant veto rolls back and suppresses after-hooks", () => {
  const events: string[] = [];
  const db = make({ children: { beforeRestore: () => false },
    parents: { beforeRestore: () => { events.push("before"); },
      afterRestore: () => { events.push("after"); } } });
  const p = db.parents.insert({ name: "p" });
  const c = db.children.insert({ name: "c", parentId: p.id });
  db.parents.delete(p.id);
  expect(() => db.parents.restore(p.id)).toThrow(/Cascade cancelled/);
  expect(stamp(db, "parents", p.id)).not.toBeNull();
  expect(stamp(db, "children", c.id)).not.toBeNull();
  expect(events).toEqual(["before"]);
});

test("partial unique index collision aborts the entire restore", () => {
  const db = make();
  db.exec('CREATE UNIQUE INDEX live_leaf ON "leaves"("name") WHERE "deletedAt" IS NULL');
  const p = db.parents.insert({ name: "old" });
  const c = db.children.insert({ name: "old", parentId: p.id });
  const l = db.leaves.insert({ name: "taken", childId: c.id });
  db.parents.delete(p.id);
  const other = db.parents.insert({ name: "new" });
  const live = db.children.insert({ name: "new", parentId: other.id });
  db.leaves.insert({ name: "taken", childId: live.id });
  expect(() => db.parents.restore(p.id)).toThrow(/unique constraint conflict/);
  expect([stamp(db, "parents", p.id), stamp(db, "children", c.id), stamp(db, "leaves", l.id)]
    .every((x) => x !== null)).toBe(true);
});
