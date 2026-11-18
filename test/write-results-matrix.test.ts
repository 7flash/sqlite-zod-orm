/**
 * Write-result matrix (4.0.11).
 *
 * Reproduce a failure:
 *   WRITE_MATRIX_SEED=123 bun test test/write-results-matrix.test.ts
 * The 2^4 option grid is run outside a transaction, in a committed
 * transaction, and in a deliberately rolled-back transaction.
 *
 * The oracle uses raw SQL rows, SQLite total_changes(), the _changes journal,
 * and independently enumerated lifecycle events; it never trusts a write
 * return value to determine the number of changed rows.
 */
import { expect, test } from "bun:test";
import { Database, z } from "../src";

type Table = "items" | "parents" | "children" | "leaves";
type Change = { tbl: string; op: "insert" | "update" | "delete"; row_id: number };
type Mode = "outside" | "commit" | "rollback";
type Options = { reactive: boolean; softDeletes: boolean; timestamps: boolean; hooks: boolean };
type Result = { writes: Change[]; calls: string[]; check?: () => void };

const schemas = {
  items: z.object({
    key: z.string(), value: z.number().default(0), tag: z.string().default("default"),
  }),
  parents: z.object({ name: z.string() }),
  children: z.object({ name: z.string(), parentId: z.number().nullable() }),
  leaves: z.object({ name: z.string(), childId: z.number().nullable() }),
};
const tables: Table[] = ["items", "parents", "children", "leaves"];
const rollback = new Error("write-matrix-rollback");
const deletedOp = (soft: boolean): "update" | "delete" => soft ? "update" : "delete";
const change = (tbl: Table, op: Change["op"], row_id: number): Change => ({ tbl, op, row_id });
const sortedChanges = (xs: Change[]) => xs.map(x => ({ ...x }))
  .sort((a, b) => `${a.tbl}/${a.op}/${a.row_id}`.localeCompare(`${b.tbl}/${b.op}/${b.row_id}`));
const rowFields = (row: any) => row && Object.fromEntries(
  ["id", "key", "value", "tag", "name", "parentId", "childId", "createdAt", "updatedAt", "deletedAt"]
    .filter(k => k in row).map(k => [k, row[k]]),
);

function matrix(options: Options) {
  let db: any;
  const calls: string[] = [];
  const hooks: Record<string, any> = {};
  if (options.hooks) for (const table of tables) {
    hooks[table] = {
      beforeInsert: (data: any) => {
        calls.push(`beforeInsert:${table}:${data.key ?? data.name}`);
        return data;
      },
      afterInsert: (entity: any) => {
        const raw = db.raw(`SELECT * FROM "${table}" WHERE id = ?`, entity.id)[0];
        expect(raw).toBeDefined();
        if ("key" in entity) expect(raw.key).toBe(entity.key);
        calls.push(`afterInsert:${table}:${entity.id}`);
      },
      beforeUpdate: (data: any, id: number) => {
        expect(typeof id).toBe("number");
        expect(data).toBeDefined();
        calls.push(`beforeUpdate:${table}:${id}`);
        return data;
      },
      afterUpdate: (entity: any) => {
        const raw = db.raw(`SELECT * FROM "${table}" WHERE id = ?`, entity.id)[0];
        expect(raw).toBeDefined();
        if ("value" in entity) expect(raw.value).toBe(entity.value);
        calls.push(`afterUpdate:${table}:${entity.id}`);
      },
      beforeDelete: (id: number) => {
        calls.push(`beforeDelete:${table}:${id}`);
      },
      afterDelete: (id: number) => {
        const raw = db.raw(`SELECT * FROM "${table}" WHERE id = ?`, id)[0];
        expect(options.softDeletes ? raw?.deletedAt != null : raw === undefined).toBe(true);
        calls.push(`afterDelete:${table}:${id}`);
      },
      beforeRestore: (id: number) => {
        calls.push(`beforeRestore:${table}:${id}`);
      },
      afterRestore: (id: number) => {
        expect(db.raw(`SELECT "deletedAt" FROM "${table}" WHERE id = ?`, id)[0]?.deletedAt)
          .toBeNull();
        calls.push(`afterRestore:${table}:${id}`);
      },
    };
  }
  db = new Database(":memory:", schemas, {
    ...options, hooks,
    unique: { items: [["key"]] },
    relations: {
      children: { parentId: "parents" },
      leaves: { childId: "children" },
    },
    cascade: { parents: ["children"], children: ["leaves"] },
  } as any);

  const rows = () => Object.fromEntries(tables.map(table => [
    table, db.raw(`SELECT * FROM "${table}" ORDER BY id`),
  ]));
  const journal = (): Change[] => options.reactive
    ? db.raw('SELECT tbl, op, row_id FROM "_changes" ORDER BY id')
    : [];
  const total = (): number =>
    db.raw("SELECT total_changes() AS n")[0].n;
  const ids = (sql: string, ...params: any[]): number[] =>
    db.raw(sql, ...params).map((r: any) => r.id);
  const live = (id: number) => db.items.get(id);
  const fresh = (entity: any): void => {
    const saved = db.items.get(entity.id);
    expect(saved).not.toBeNull();
    expect(rowFields(entity)).toEqual(rowFields(saved));
    if (options.timestamps) {
      expect(typeof entity.createdAt).toBe("string");
      expect(typeof entity.updatedAt).toBe("string");
    }
  };
  const hk = (...events: string[]) => options.hooks ? events : [];
  const initial = [
    db.items.insert({ key: "base", value: 1 }),
    db.items.insert({ key: "second", value: 2 }),
    db.items.insert({ key: "third", value: 3 }),
  ];
  calls.length = 0;

  const run = (mode: Mode, label: string, action: () => Result): void => {
    calls.length = 0;
    const previousRows = rows();
    const previousJournal = journal();
    const previousTotal = total();
    let expected: Result | undefined;
    const body = () => {
      expected = action();
      // In a transaction, after-hooks must not have been delivered yet.
      if (mode !== "outside")
        expect(calls.every(call => !call.startsWith("after"))).toBe(true);
      expected.check?.();
      if (mode === "rollback") throw rollback;
    };
    if (mode === "outside") body();
    else if (mode === "commit") db.transaction(body);
    else expect(() => db.transaction(body)).toThrow("write-matrix-rollback");
    if (!expected) throw new Error(`Missing oracle for ${label}`);

    const after = calls.slice();
    if (mode === "rollback") {
      expect(rows()).toEqual(previousRows);
      expect(journal()).toEqual(previousJournal);
      expect(after).toEqual(expected.calls.filter(call => call.startsWith("before")));
    } else {
      expect(after).toEqual(expected.calls);
      const newEntries = journal().slice(previousJournal.length);
      if (options.reactive)
        expect(sortedChanges(newEntries)).toEqual(sortedChanges(expected.writes));
      else expect(journal()).toEqual([]);
      // total_changes() includes trigger writes, unlike changes(). Since each
      // journal entry is one INSERT into _changes, this equation detects both
      // missing journal events and duplicate journaling per physical row write.
      expect(total() - previousTotal).toBe(
        expected.writes.length + (options.reactive ? expected.writes.length : 0),
      );
    }
    calls.length = 0;
  };

  return { db, calls, hk, run, rows, journal, ids, live, fresh, initial };
}

for (let mask = 0; mask < 16; mask++) {
  const options: Options = {
    reactive: !!(mask & 1),
    softDeletes: !!(mask & 2),
    timestamps: !!(mask & 4),
    hooks: !!(mask & 8),
  };
  for (const mode of ["outside", "commit", "rollback"] as const) {
    test(`write results: ${JSON.stringify(options)}, mode=${mode}`, () => {
      const m = matrix(options);
      const { db, hk, run, ids, live, fresh, initial } = m;
      const [base, second, third] = initial;
      const deleteEvent = deletedOp(options.softDeletes);
      const vis = options.softDeletes ? ' AND "deletedAt" IS NULL' : "";
      try {
        run(mode, "insert", () => {
          const entity = db.items.insert({ key: "inserted", value: 7 });
          return {
            writes: [change("items", "insert", entity.id)],
            calls: hk("beforeInsert:items:inserted", `afterInsert:items:${entity.id}`),
            check: () => fresh(entity),
          };
        });

        run(mode, "insertMany empty", () => {
          expect(db.items.insertMany([])).toEqual([]);
          return { writes: [], calls: [] };
        });

        run(mode, "insertMany", () => {
          const result = db.items.insertMany([
            { key: "many-one", value: 8 }, { key: "many-two", value: 9 },
          ]);
          expect(result).toHaveLength(2);
          return {
            writes: result.map((r: any) => change("items", "insert", r.id)),
            calls: hk(
              "beforeInsert:items:many-one", "beforeInsert:items:many-two",
              ...result.map((r: any) => `afterInsert:items:${r.id}`),
            ),
            check: () => result.forEach(fresh),
          };
        });

        run(mode, "update(id)", () => {
          const entity = db.items.update(base.id, { value: 11 });
          expect(entity).not.toBeNull();
          return {
            writes: [change("items", "update", base.id)],
            calls: hk(`beforeUpdate:items:${base.id}`, `afterUpdate:items:${base.id}`),
            check: () => { expect(entity.value).toBe(11); fresh(entity); },
          };
        });

        run(mode, "update missing id", () => {
          expect(db.items.update(999999, { value: 20 })).toBeNull();
          return { writes: [], calls: [] };
        });

        run(mode, "update(entity)", () => {
          const entity = db.items.get(second.id)!.update({ value: 12 });
          return {
            writes: [change("items", "update", second.id)],
            calls: hk(`beforeUpdate:items:${second.id}`, `afterUpdate:items:${second.id}`),
            check: () => { expect(entity.value).toBe(12); fresh(entity); },
          };
        });

        run(mode, "update().where().exec()", () => {
          const matched = ids(`SELECT id FROM items WHERE value >= 0${vis} ORDER BY id`);
          const result = db.items.update({ tag: "bulk" })
            .where({ value: { $gte: 0 } }).exec();
          expect(result).toBe(matched.length);
          return {
            writes: matched.map(id => change("items", "update", id)),
            calls: [],
            check: () => matched.forEach(id =>
              expect(db.raw("SELECT tag FROM items WHERE id = ?", id)[0].tag).toBe("bulk")),
          };
        });

        run(mode, "upsert insert", () => {
          const entity = db.items.upsert({ key: "upsert-new" }, { value: 13 });
          return {
            writes: [change("items", "insert", entity.id)],
            calls: hk("beforeInsert:items:upsert-new", `afterInsert:items:${entity.id}`),
            check: () => { expect(entity.value).toBe(13); fresh(entity); },
          };
        });

        run(mode, "upsert update", () => {
          const entity = db.items.upsert({ key: "base" }, { value: 22 });
          expect(entity.id).toBe(base.id);
          return {
            writes: [change("items", "update", base.id)],
            calls: hk(`beforeUpdate:items:${base.id}`, `afterUpdate:items:${base.id}`),
            check: () => { expect(entity.value).toBe(22); fresh(entity); },
          };
        });

        // The tombstone is fixture state, not part of the measured upsert.
        const revive = db.items.insert({ key: "revive", value: 1 });
        db.items.delete(revive.id);
        run(mode, "upsert revive", () => {
          const entity = db.items.upsert({ key: "revive" }, { value: 23 });
          return options.softDeletes ? {
            writes: [
              change("items", "update", revive.id),
              change("items", "update", revive.id),
            ],
            calls: hk(
              `beforeRestore:items:${revive.id}`, `beforeUpdate:items:${revive.id}`,
              `afterRestore:items:${revive.id}`, `afterUpdate:items:${revive.id}`,
            ),
            check: () => { expect(entity.id).toBe(revive.id); fresh(entity); },
          } : {
            writes: [change("items", "insert", entity.id)],
            calls: hk("beforeInsert:items:revive", `afterInsert:items:${entity.id}`),
            check: () => fresh(entity),
          };
        });

        run(mode, "upsertMany empty", () => {
          expect(db.items.upsertMany([])).toEqual([]);
          return { writes: [], calls: [] };
        });

        run(mode, "upsertMany mixed", () => {
          const returned = db.items.upsertMany([
            { id: third.id, value: 24 }, { key: "batch-new", value: 25 },
          ]);
          expect(returned).toHaveLength(2);
          expect(returned[0].id).toBe(third.id);
          return {
            writes: [change("items", "update", third.id),
              change("items", "insert", returned[1].id)],
            calls: hk(
              `beforeUpdate:items:${third.id}`, "beforeInsert:items:batch-new",
              `afterUpdate:items:${third.id}`, `afterInsert:items:${returned[1].id}`,
            ),
            check: () => returned.forEach(fresh),
          };
        });

        run(mode, "findOrCreate created", () => {
          const result = db.items.findOrCreate({ key: "find-new" }, { value: 26 });
          expect(result.created).toBe(true);
          return {
            writes: [change("items", "insert", result.entity.id)],
            calls: hk("beforeInsert:items:find-new", `afterInsert:items:${result.entity.id}`),
            check: () => fresh(result.entity),
          };
        });

        run(mode, "findOrCreate found", () => {
          const result = db.items.findOrCreate({ key: "base" }, { value: 999 });
          expect(result.created).toBe(false);
          expect(result.entity.id).toBe(base.id);
          return { writes: [], calls: [], check: () => fresh(result.entity) };
        });

        const del = db.items.insert({ key: "delete-id", value: 1 });
        run(mode, "delete(id)", () => {
          expect(db.items.delete(del.id)).toBeUndefined();
          return {
            writes: [change("items", deleteEvent, del.id)],
            calls: hk(`beforeDelete:items:${del.id}`, `afterDelete:items:${del.id}`),
            check: () => {
              expect(db.items.get(del.id)).toBeNull();
              expect(db.raw("SELECT * FROM items WHERE id = ?", del.id).length)
                .toBe(options.softDeletes ? 1 : 0);
            },
          };
        });

        // A rolled-back delete leaves the fixture live; remove it outside
        // the measured operation to test the absent/tombstoned branch.
        if (db.items.get(del.id)) db.items.delete(del.id);
        run(mode, "delete absent/tombstoned id", () => {
          expect(db.items.delete(del.id)).toBeUndefined();
          return { writes: [], calls: [] };
        });

        const bulk = db.items.insertMany([
          { key: "bulk-del-a", value: 41 }, { key: "bulk-del-b", value: 42 },
        ]);
        run(mode, "delete().where().exec()", () => {
          const matched = ids(`SELECT id FROM items WHERE value >= 41${vis} ORDER BY id`);
          const count = db.items.delete().where({ value: { $gte: 41 } }).exec();
          expect(count).toBe(matched.length);
          return {
            writes: matched.map(id => change("items", deleteEvent, id)),
            calls: [],
            check: () => matched.forEach(id => expect(db.items.get(id)).toBeNull()),
          };
        });

        const restoring = db.items.insert({ key: "restore-me", value: 43 });
        db.items.delete(restoring.id);
        if (options.softDeletes) {
          run(mode, "restore", () => {
            expect(db.items.restore(restoring.id)).toBeUndefined();
            return {
              writes: [change("items", "update", restoring.id)],
              calls: hk(`beforeRestore:items:${restoring.id}`, `afterRestore:items:${restoring.id}`),
              check: () => { expect(db.items.get(restoring.id)).not.toBeNull(); },
            };
          });
          // The preceding restore is rolled back in rollback mode.
          // Establish a live fixture before measuring the idempotent call.
          if (!db.items.get(restoring.id)) db.items.restore(restoring.id);
          run(mode, "restore already live", () => {
            expect(db.items.restore(restoring.id)).toBeUndefined();
            return { writes: [], calls: [] };
          });
        } else {
          const old = m.rows();
          expect(() => db.items.restore(restoring.id)).toThrow(/softDeletes/);
          expect(m.rows()).toEqual(old);
        }

        run(mode, "entity.update()", () => {
          const returned = db.items.get(base.id)!.update({ value: 30 });
          return {
            writes: [change("items", "update", base.id)],
            calls: hk(`beforeUpdate:items:${base.id}`, `afterUpdate:items:${base.id}`),
            check: () => { expect(returned.value).toBe(30); fresh(returned); },
          };
        });

        run(mode, "property assignment", () => {
          const entity = db.items.get(base.id)!;
          expect(entity.tag).not.toBe("assignment");
          entity.tag = "assignment";
          return {
            writes: [change("items", "update", base.id)],
            calls: hk(`beforeUpdate:items:${base.id}`, `afterUpdate:items:${base.id}`),
            check: () => { expect(entity.tag).toBe("assignment"); fresh(entity); },
          };
        });

        run(mode, "property assignment unchanged", () => {
          const entity = db.items.get(base.id)!;
          const value = entity.tag;
          entity.tag = value;
          return { writes: [], calls: [], check: () => expect(entity.tag).toBe(value) };
        });

        const deleteMe = db.items.insert({ key: "entity-delete", value: 10 });
        run(mode, "entity.delete()", () => {
          expect(deleteMe.delete()).toBeUndefined();
          return {
            writes: [change("items", deleteEvent, deleteMe.id)],
            calls: hk(`beforeDelete:items:${deleteMe.id}`, `afterDelete:items:${deleteMe.id}`),
            check: () => expect(db.items.get(deleteMe.id)).toBeNull(),
          };
        });

        const parent = db.parents.insert({ name: "parent" });
        const child = db.children.insert({ name: "child", parentId: parent.id });
        const leaf = db.leaves.insert({ name: "leaf", childId: child.id });
        run(mode, "cascade delete", () => {
          expect(db.parents.delete(parent.id)).toBeUndefined();
          return {
            writes: [change("leaves", deleteEvent, leaf.id),
              change("children", deleteEvent, child.id),
              change("parents", deleteEvent, parent.id)],
            calls: hk(
              `beforeDelete:parents:${parent.id}`,
              `beforeDelete:children:${child.id}`,
              `beforeDelete:leaves:${leaf.id}`,
              `afterDelete:leaves:${leaf.id}`,
              `afterDelete:children:${child.id}`,
              `afterDelete:parents:${parent.id}`,
            ),
            check: () => {
              for (const [table, id] of [["parents", parent.id],
                ["children", child.id], ["leaves", leaf.id]] as const)
                expect(db[table].get(id)).toBeNull();
            },
          };
        });

        // Build a tombstone cohort for the restore test independently of
        // whether the prior measured deletion committed or rolled back.
        if (options.softDeletes) {
          const p = db.parents.insert({ name: "restore-parent" });
          const c = db.children.insert({ name: "restore-child", parentId: p.id });
          const l = db.leaves.insert({ name: "restore-leaf", childId: c.id });
          db.parents.delete(p.id);
          run(mode, "cascade restore", () => {
            expect(db.parents.restore(p.id)).toBeUndefined();
            return {
              writes: [change("parents", "update", p.id),
                change("children", "update", c.id), change("leaves", "update", l.id)],
              calls: hk(
                `beforeRestore:parents:${p.id}`,
                `beforeRestore:children:${c.id}`,
                `beforeRestore:leaves:${l.id}`,
                `afterRestore:leaves:${l.id}`,
                `afterRestore:children:${c.id}`,
                `afterRestore:parents:${p.id}`,
              ),
              check: () => {
                expect(db.parents.get(p.id)).not.toBeNull();
                expect(db.children.get(c.id)).not.toBeNull();
                expect(db.leaves.get(l.id)).not.toBeNull();
              },
            };
          });
        }

        const bulkP = db.parents.insert({ name: "bulk-parent" });
        const bulkC = db.children.insert({ name: "bulk-child", parentId: bulkP.id });
        const bulkL = db.leaves.insert({ name: "bulk-leaf", childId: bulkC.id });
        run(mode, "delete().where() cascade", () => {
          const count = db.parents.delete().where({ name: "bulk-parent" }).exec();
          expect(count).toBe(1);
          return {
            writes: [change("leaves", deleteEvent, bulkL.id),
              change("children", deleteEvent, bulkC.id),
              change("parents", deleteEvent, bulkP.id)],
            calls: [],
            check: () => expect(db.leaves.get(bulkL.id)).toBeNull(),
          };
        });

        const p1 = db.parents.insert({ name: "select-parent-a" });
        const p2 = db.parents.insert({ name: "select-parent-b" });
        const c1 = db.children.insert({ name: "select-child-a", parentId: p1.id });
        const c2 = db.children.insert({ name: "select-child-b", parentId: p2.id });
        const l1 = db.leaves.insert({ name: "select-leaf-a", childId: c1.id });
        const l2 = db.leaves.insert({ name: "select-leaf-b", childId: c2.id });
        run(mode, "select().deleteAll() multi-root cascade", () => {
          const count = db.parents.select()
            .where({ name: { $like: "select-parent-%" } }).deleteAll();
          expect(count).toBe(2);
          const all = [
            [p1.id, c1.id, l1.id], [p2.id, c2.id, l2.id],
          ];
          return {
            writes: all.flatMap(([p, c, l]) => [
              change("leaves", deleteEvent, l!),
              change("children", deleteEvent, c!),
              change("parents", deleteEvent, p!),
            ]),
            calls: [],
            check: () => {
              expect(db.parents.get(p1.id)).toBeNull();
              expect(db.parents.get(p2.id)).toBeNull();
              expect(db.leaves.get(l1.id)).toBeNull();
              expect(db.leaves.get(l2.id)).toBeNull();
            },
          };
        });

        run(mode, "select().updateAll()", () => {
          const matched = ids(`SELECT id FROM items WHERE key = 'base'${vis}`);
          const n = db.items.select().where({ key: "base" }).updateAll({ value: 44 });
          expect(n).toBe(matched.length);
          return {
            writes: matched.map(id => change("items", "update", id)),
            calls: [], check: () => expect(db.items.get(base.id)?.value).toBe(44),
          };
        });

        run(mode, "select().increment()", () => {
          const matched = ids(`SELECT id FROM items WHERE key = 'base'${vis}`);
          const before = db.items.get(base.id).value;
          const n = db.items.select().where({ key: "base" }).increment("value", 3);
          expect(n).toBe(matched.length);
          return {
            writes: matched.map(id => change("items", "update", id)),
            calls: [], check: () => expect(db.items.get(base.id)?.value).toBe(before + 3),
          };
        });

        run(mode, "select().decrement()", () => {
          const matched = ids(`SELECT id FROM items WHERE key = 'base'${vis}`);
          const before = db.items.get(base.id).value;
          const n = db.items.select().where({ key: "base" }).decrement("value", 2);
          expect(n).toBe(matched.length);
          return {
            writes: matched.map(id => change("items", "update", id)),
            calls: [], check: () => expect(db.items.get(base.id)?.value).toBe(before - 2),
          };
        });

        const selected = db.items.insertMany([
          { key: "select-del-a" }, { key: "select-del-b" },
        ]);
        run(mode, "select().deleteAll()", () => {
          const matched = ids(`SELECT id FROM items WHERE key LIKE 'select-del-%'${vis}`);
          const n = db.items.select().where({ key: { $like: "select-del-%" } }).deleteAll();
          expect(n).toBe(matched.length);
          return {
            writes: matched.map(id => change("items", deleteEvent, id)),
            calls: [], check: () => selected.forEach((r: any) =>
              expect(db.items.get(r.id)).toBeNull()),
          };
        });

        // Native SQLite ON CONFLICT paths are also writes, though their
        // beforeInsert hook observes the attempted insert on either branch.
        run(mode, "native conflict INSERT", () => {
          const entity = db.items.upsert({ key: "native-new", value: 51 }, {
            on: "key", merge: (t: any) => ({ value: t.excluded("value") }),
          });
          return {
            writes: [change("items", "insert", entity.id)],
            calls: hk("beforeInsert:items:native-new", `afterInsert:items:${entity.id}`),
            check: () => fresh(entity),
          };
        });

        run(mode, "native conflict UPDATE", () => {
          const entity = db.items.upsert({ key: "base", value: 52 }, {
            on: "key", merge: (t: any) => ({ value: t.excluded("value") }),
          });
          return {
            writes: [change("items", "update", base.id)],
            calls: hk("beforeInsert:items:base", `afterUpdate:items:${base.id}`),
            check: () => { expect(entity.id).toBe(base.id); fresh(entity); },
          };
        });

        run(mode, "native conflict DO NOTHING", () => {
          const entity = db.items.upsert({ key: "base", value: 999 }, {
            on: "key", doNothing: true,
          });
          return { writes: [], calls: hk("beforeInsert:items:base"),
            check: () => { expect(entity.id).toBe(base.id); fresh(entity); } };
        });

        run(mode, "native conflict DO NOTHING insert", () => {
          const entity = db.items.upsert({ key: "native-insert", value: 53 }, {
            on: "key", doNothing: true,
          });
          return { writes: [change("items", "insert", entity.id)],
            calls: hk("beforeInsert:items:native-insert", `afterInsert:items:${entity.id}`),
            check: () => fresh(entity) };
        });

        run(mode, "upsertOnConflict alias", () => {
          const entity = db.items.upsertOnConflict(
            { key: "base", value: 54 }, "key",
            (t: any) => ({ value: t.excluded("value") }),
          );
          return { writes: [change("items", "update", base.id)],
            calls: hk("beforeInsert:items:base", `afterUpdate:items:${base.id}`),
            check: () => fresh(entity) };
        });

        run(mode, "native conflict changes target", () => {
          const entity = db.items.upsert({ key: "base", value: 55 }, {
            on: "key", merge: (t: any) => ({
              key: t.literal("renamed-after-conflict"),
              value: t.excluded("value"),
            }),
          });
          return {
            writes: [change("items", "update", base.id)],
            calls: hk("beforeInsert:items:base", `afterUpdate:items:${base.id}`),
            check: () => {
              expect(entity.id).toBe(base.id);
              expect(entity.key).toBe("renamed-after-conflict");
              fresh(entity);
            },
          };
        });

        // A load/seed writes raw records and explicitly does not dispatch
        // model hooks. Foreign key enforcement prevents load in a transaction.
        if (mode === "outside") {
          run(mode, "seed()", () => {
            db.seed({ items: [{ key: "seed-new", value: 61, tag: "seed" }] });
            const inserted = ids("SELECT id FROM items WHERE key = 'seed-new'");
            expect(inserted).toHaveLength(1);
            return { writes: [change("items", "insert", inserted[0]!)], calls: [] };
          });
          run(mode, "load() replace", () => {
            const removed = ids("SELECT id FROM items ORDER BY id");
            db.load({ items: [{ key: "loaded", value: 62, tag: "load" }] });
            const inserted = ids("SELECT id FROM items WHERE key = 'loaded'");
            expect(inserted).toHaveLength(1);
            return {
              writes: [...removed.map(id => change("items", "delete", id)),
                change("items", "insert", inserted[0]!)],
              calls: [], check: () => expect(db.items.count()).toBe(1),
            };
          });
        } else {
          const snap = m.rows();
          const log = m.journal();
          expect(() => db.transaction(() =>
            db.seed({ items: [{ key: "blocked-seed", value: 63, tag: "x" }] })))
            .toThrow(/load cannot run inside an existing transaction/);
          expect(() => db.transaction(() =>
            db.load({ items: [{ key: "blocked-load", value: 63, tag: "x" }] })))
            .toThrow(/load cannot run inside an existing transaction/);
          expect(m.rows()).toEqual(snap);
          expect(m.journal()).toEqual(log);
        }
      } finally {
        db.close();
      }
    });
  }
}

test("hooks are dispatched only after the enclosing commit, not after a savepoint", () => {
  const db: any = new Database(":memory:", {
    items: schemas.items,
  }, { reactive: true, hooks: { items: {
    afterInsert: (row: any) => fired.push(row.key),
  } } });
  const fired: string[] = [];
  try {
    db.transaction(() => {
      db.items.insert({ key: "outer", value: 1 });
      try {
        db.transaction(() => {
          db.items.insert({ key: "aborted", value: 2 });
          throw Error("abort-savepoint");
        });
      } catch (error) { expect(String(error)).toContain("abort-savepoint"); }
      db.items.insert({ key: "kept", value: 3 });
      expect(fired).toEqual([]);
    });
    expect(fired).toEqual(["outer", "kept"]);
    expect(db.raw("SELECT key FROM items ORDER BY id").map((r: any) => r.key))
      .toEqual(["outer", "kept"]);
    expect(db.raw('SELECT tbl, op FROM "_changes" ORDER BY id'))
      .toEqual([{ tbl: "items", op: "insert" }, { tbl: "items", op: "insert" }]);
  } finally { db.close(); }
});

test("a property assignment reflects hook transformations, including other columns", () => {
  let observed = 0;
  const db: any = new Database(":memory:", { items: schemas.items }, {
    reactive: true,
    hooks: { items: {
      beforeUpdate: (data: any) => ({ ...data, tag: "from-hook", value: 88 }),
      afterUpdate: () => { observed++; },
    } },
  });
  try {
    const entity = db.items.insert({ key: "original", tag: "old", value: 1 });
    entity.tag = "requested";
    expect(entity.tag).toBe("from-hook");
    expect(entity.value).toBe(88);
    expect(rowFields(entity)).toEqual(rowFields(db.items.get(entity.id)));
    expect(observed).toBe(1);
    expect(db.raw('SELECT op FROM "_changes"')).toEqual([
      { op: "insert" }, { op: "update" },
    ]);
  } finally { db.close(); }
});

test("explicit id zero is a valid upsert match, and findOrCreate conditions win", () => {
  const db: any = new Database(":memory:", { items: schemas.items }, {
    reactive: true, unique: { items: [["key"]] },
  });
  try {
    db.exec('INSERT INTO items(id, "key", value, tag) VALUES (0, ?, 1, ?)', "zero", "x");
    const updated = db.items.upsert({}, { id: 0, value: 15 });
    expect(updated.id).toBe(0);
    expect(updated.value).toBe(15);
    expect(db.raw('SELECT id, value FROM items WHERE id = 0')).toEqual([
      { id: 0, value: 15 },
    ]);
    const made = db.items.findOrCreate({ key: "required" }, {
      key: "inconsistent", value: 16,
    });
    expect(made.created).toBe(true);
    expect(made.entity.key).toBe("required");
    expect(db.items.findOrCreate({ key: "required" }).created).toBe(false);
    expect(db.raw('SELECT COUNT(*) AS n FROM items')[0].n).toBe(2);
  } finally { db.close(); }
});

test("ON CONFLICT RETURNING returns an inserted NULL-target row", () => {
  let inserts = 0;
  const db: any = new Database(":memory:", {
    nullable: z.object({ key: z.string().nullable(), value: z.number() }),
  }, { reactive: true, unique: { nullable: [["key"]] },
    hooks: { nullable: { afterInsert: () => { inserts++; } } } });
  try {
    const first = db.nullable.upsert({ key: null, value: 1 }, {
      on: "key", doNothing: true,
    });
    const second = db.nullable.upsert({ key: null, value: 2 }, {
      on: "key", doNothing: true,
    });
    // UNIQUE in SQLite allows multiple NULLs; neither INSERT is ignored.
    expect([first.id, second.id]).toEqual([1, 2]);
    expect([first.value, second.value]).toEqual([1, 2]);
    expect(inserts).toBe(2);
    expect(db.raw('SELECT op, row_id FROM "_changes" ORDER BY id')).toEqual([
      { op: "insert", row_id: 1 }, { op: "insert", row_id: 2 },
    ]);
  } finally { db.close(); }
});

test("an empty update does not touch the row, timestamp, journal, or after-hook", () => {
  for (const timestamps of [false, true]) for (const reactive of [false, true]) {
    let after = 0;
    const db: any = new Database(":memory:", { items: schemas.items }, {
      timestamps, reactive, hooks: { items: { afterUpdate: () => after++ } },
    });
    try {
      const entity = db.items.insert({ key: "unchanged" });
      const before = db.raw("SELECT * FROM items WHERE id = ?", entity.id);
      const total = db.raw("SELECT total_changes() AS n")[0].n;
      expect(db.items.update(entity.id, {})).not.toBeNull();
      expect(db.raw("SELECT total_changes() AS n")[0].n).toBe(total);
      expect(db.raw("SELECT * FROM items WHERE id = ?", entity.id)).toEqual(before);
      expect(after).toBe(0);
    } finally { db.close(); }
  }
});

test("a late upsertMany constraint failure rolls back early rows and all after-hooks", () => {
  const after: string[] = [];
  const db: any = new Database(":memory:", { items: schemas.items }, {
    reactive: true, unique: { items: [["key"]] },
    hooks: { items: {
      afterInsert: (row: any) => { after.push(`insert:${row.id}`); },
      afterUpdate: (row: any) => { after.push(`update:${row.id}`); },
    } },
  });
  try {
    const base = db.items.insert({ key: "base", value: 1 });
    after.length = 0;
    const beforeRows = db.raw("SELECT * FROM items ORDER BY id");
    const beforeJournal = db.raw('SELECT * FROM "_changes" ORDER BY id');
    expect(() => db.items.upsertMany([
      { id: base.id, value: 9 },
      { key: "temporary", value: 2 },
      { key: "base", value: 3 }, // no ID, so this tries INSERT and violates UNIQUE
    ])).toThrow();
    expect(db.raw("SELECT * FROM items ORDER BY id")).toEqual(beforeRows);
    expect(db.raw('SELECT * FROM "_changes" ORDER BY id')).toEqual(beforeJournal);
    expect(after).toEqual([]);
  } finally { db.close(); }
});

test("select().updateAll() refreshes updatedAt even when WHERE tests updatedAt", () => {
  const db: any = new Database(":memory:", { items: schemas.items }, {
    timestamps: true, reactive: true,
  });
  try {
    const entity = db.items.insert({ key: "timestamp-filter", value: 1 });
    const oldStamp = "2000-01-01T00:00:00.000Z";
    db.exec('UPDATE items SET "updatedAt" = ? WHERE id = ?', oldStamp, entity.id);
    const previous = db.raw('SELECT COUNT(*) AS n FROM "_changes"')[0].n;
    expect(db.items.select().where({ updatedAt: oldStamp })
      .updateAll({ value: 4 })).toBe(1);
    const fresh = db.raw("SELECT value, updatedAt FROM items WHERE id = ?", entity.id)[0];
    expect(fresh.value).toBe(4);
    expect(fresh.updatedAt).not.toBe(oldStamp);
    expect(db.raw('SELECT COUNT(*) AS n FROM "_changes"')[0].n - previous).toBe(1);
  } finally { db.close(); }
});

// Independent seeded sequence oracle. Each sequence is replayable; on failure,
// delta debugging removes operations while preserving the failing invariant.
type Op = { kind: "insert" | "update" | "bulk" | "upsert" | "delete" | "restore" |
  "find" | "many" | "property" | "rollback"; key: number; value: number };
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}
const opKinds: Op["kind"][] = ["insert", "update", "bulk", "upsert", "delete",
  "restore", "find", "many", "property", "rollback"];
function replay(ops: Op[], opts: Options): void {
  let afterInsert = 0;
  const db: any = new Database(":memory:", { items: schemas.items }, {
    ...opts, unique: { items: [["key"]] },
    hooks: opts.hooks ? { items: { afterInsert: () => afterInsert++ } } : {},
  } as any);
  const snap = () => db.raw("SELECT * FROM items ORDER BY id");
  const journal = () => opts.reactive
    ? db.raw('SELECT tbl, op, row_id FROM "_changes" ORDER BY id') : [];
  const total = () => db.raw("SELECT total_changes() AS n")[0].n as number;
  try {
    for (const [index, op] of ops.entries()) {
      const old = snap(), prev = journal(), previousTotal = total();
      let expectedWrites = 0;
      let inserted = 0;
      const beforeAfterInsert = afterInsert;
      let row: any = null;
      const first = old.find((r: any) => !opts.softDeletes || r.deletedAt === null);
      const key = `r-${op.key}`;
      const callback = () => {
        switch (op.kind) {
          case "insert": {
            row = db.items.insert({ key: `i-${index}-${key}`, value: op.value });
            inserted = 1; expectedWrites = 1; break;
          }
          case "many": {
            const result = db.items.insertMany([
              { key: `m1-${index}-${key}`, value: op.value },
              { key: `m2-${index}-${key}`, value: op.value + 1 },
            ]);
            result.forEach((r: any) => expect(db.items.get(r.id)?.value).toBe(r.value));
            inserted = 2; expectedWrites = 2; break;
          }
          case "find": {
            const tombstone = opts.softDeletes && old.some(
              (r: any) => r.key === key && r.deletedAt != null);
            if (tombstone) {
              // findOrCreate deliberately does not revive tombstones;
              // SQLite's retained UNIQUE index rejects an attempted insert.
              expect(() => db.items.findOrCreate({ key }, { value: op.value })).toThrow();
            } else {
              const result = db.items.findOrCreate({ key }, { value: op.value });
              row = result.entity;
              inserted = Number(result.created);
              expectedWrites = inserted;
            }
            break;
          }
          case "upsert": {
            const found = db.raw(
              `SELECT id${opts.softDeletes ? ", deletedAt" : ""} FROM items WHERE key = ?`, key)[0];
            row = db.items.upsert({ key }, { value: op.value });
            inserted = found ? 0 : 1;
            expectedWrites = found ? (found.deletedAt ? 2 : 1) : 1;
            break;
          }
          case "update": {
            if (first) {
              row = db.items.update(first.id, { value: op.value });
              expectedWrites = 1;
            }
            break;
          }
          case "property": {
            if (first) {
              row = db.items.get(first.id);
              row.value = op.value;
              expectedWrites = Number(old.find((r: any) => r.id === first.id)!.value !== op.value);
            }
            break;
          }
          case "bulk": {
            const count = db.items.update({ tag: `b-${index}` }).where({ value: { $gte: 0 } }).exec();
            const eligible = old.filter((r: any) => (!opts.softDeletes || r.deletedAt == null) && r.value >= 0);
            expect(count).toBe(eligible.length);
            expectedWrites = count;
            break;
          }
          case "delete": {
            if (first) { db.items.delete(first.id); expectedWrites = 1; }
            break;
          }
          case "restore": {
            if (opts.softDeletes) {
              const tombstone = old.find((r: any) => r.deletedAt != null);
              if (tombstone) { db.items.restore(tombstone.id); expectedWrites = 1; }
            }
            break;
          }
          case "rollback": {
            const before = snap(), changes = journal(), count = afterInsert;
            expect(() => db.transaction(() => {
              db.items.insert({ key: `abort-${index}-${key}`, value: op.value });
              throw new Error("forced-rollback");
            })).toThrow("forced-rollback");
            expect(snap()).toEqual(before);
            expect(journal()).toEqual(changes);
            expect(afterInsert).toBe(count);
            break;
          }
        }
      };
      // Some cases intentionally have zero affected rows.
      callback();
      if (row) {
        const saved = db.items.get(row.id);
        expect(rowFields(row)).toEqual(rowFields(saved));
      }
      const delta = journal().length - prev.length;
      expect(delta).toBe(opts.reactive ? expectedWrites : 0);
      // For a rolled-back statement total_changes() still increases, so this
      // equality applies only to committed operations.
      if (op.kind !== "rollback") {
        expect(total() - previousTotal).toBe(expectedWrites * (opts.reactive ? 2 : 1));
      }
      // afterInsert is a deliberately independent event count oracle.
      if (opts.hooks) {
        expect(afterInsert - beforeAfterInsert).toBe(inserted);
      }
    }
  } finally { db.close(); }
}
function minimize(sequence: Op[], options: Options): Op[] {
  let remaining = sequence.slice();
  for (let size = Math.ceil(remaining.length / 2); size >= 1; size = Math.floor(size / 2)) {
    let reduced = true;
    while (reduced) {
      reduced = false;
      for (let start = 0; start < remaining.length; start += size) {
        const candidate = remaining.filter((_, i) => i < start || i >= start + size);
        try { replay(candidate, options); }
        catch { remaining = candidate; reduced = true; break; }
      }
    }
  }
  return remaining;
}
for (let mask = 0; mask < 16; mask++) {
  const options: Options = {
    reactive: !!(mask & 1), softDeletes: !!(mask & 2),
    timestamps: !!(mask & 4), hooks: !!(mask & 8),
  };
  test(`seeded write sequences: options=${mask}`, () => {
    const configured = Number(process.env.WRITE_MATRIX_SEED ?? "0");
    for (const variant of [0, 1, 2, 3]) {
      const seed = configured || ((0x9e3779b9 ^ (mask << 12) ^ variant * 8731) >>> 0);
      const random = rng(seed);
      const sequence: Op[] = Array.from({ length: 18 }, () => ({
        kind: opKinds[Math.floor(random() * opKinds.length)]!,
        key: Math.floor(random() * 6),
        value: Math.floor(random() * 100),
      }));
      try { replay(sequence, options); }
      catch (error) {
        const minimal = minimize(sequence, options);
        throw new Error(
          `WRITE_MATRIX_SEED=${seed}, options=${JSON.stringify(options)}, ` +
          `minimalSequence=${JSON.stringify(minimal)}, original=${JSON.stringify(sequence)}`,
          { cause: error },
        );
      }
    }
  });
}
