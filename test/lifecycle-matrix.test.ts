/**
 * Seeded state-machine lifecycle regression suite.
 *
 * Replay: MATRIX_SEED=123 MATRIX_MASK=31 MATRIX_SOFT=1 bun test test/lifecycle-matrix.test.ts
 * A failure includes the concrete operation sequence and a ddmin reduction.
 * The reference state is independent of src/crud.ts, and uses only the 4.0
 * lifecycle contract in README and UPGRADING sections 12-17, 20.
 */
import { expect, test } from "bun:test";
import { Database, z } from "../src";

type Table = "orgs" | "projects" | "tasks" | "notes" | "tags" | "taskTags";
const tables: Table[] = ["orgs", "projects", "tasks", "notes", "tags", "taskTags"];
const rel: Partial<Record<Table, Record<string, Table>>> = {
  projects: { orgId: "orgs" },
  tasks: { projectId: "projects", parentId: "tasks" },
  notes: { taskId: "tasks" },
  taskTags: { taskId: "tasks", tagId: "tags" },
};
const edges: [Table, Table][] = [
  ["orgs", "projects"], ["projects", "tasks"], ["tasks", "notes"],
  ["tasks", "tasks"], ["tasks", "taskTags"], ["tags", "taskTags"],
];
type Row = Record<string, any> & { id: number; name: string; score: number; deletedAt?: string | null };
type State = Record<Table, Row[]>;
type Op = { kind: string; table?: Table; id?: number; name?: string; score?: number;
  fk?: Record<string, number | null>; ops?: Op[]; veto?: "false" | "throw";
  vetoTable?: Table; vetoId?: number; fail?: boolean };
type Env = { db: any; state: State; mask: number; soft: boolean; veto: { table?: Table; id?: number; mode?: string };
  audit: string[]; hookEvents: string[]; txDepth: number };
const schemas = {
  orgs: z.object({ name: z.string(), score: z.number().default(0) }),
  projects: z.object({ name: z.string(), score: z.number().default(0), orgId: z.number() }),
  tasks: z.object({ name: z.string(), score: z.number().default(0), projectId: z.number(),
    parentId: z.number().nullable().optional() }),
  notes: z.object({ name: z.string(), score: z.number().default(0), taskId: z.number() }),
  tags: z.object({ name: z.string(), score: z.number().default(0) }),
  taskTags: z.object({ name: z.string(), score: z.number().default(0),
    taskId: z.number(), tagId: z.number() }),
  audit: z.object({ event: z.string() }),
};
function random(seed: number) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 0x100000000; };
}
const clone = <T,>(x: T): T => structuredClone(x);
const sorted = (xs: Row[]) => xs.map(x => ({ ...x })).sort((a,b) => a.id - b.id);
function cascade(mask: number) {
  const out: Record<string, string[]> = {};
  edges.forEach(([parent, child], bit) => {
    if (mask & (1 << bit)) (out[parent] ??= []).push(child);
  });
  return out;
}
function make(mask: number, soft: boolean): Env {
  const env: Env = {
    db: null, state: Object.fromEntries(tables.map(t => [t, []])) as unknown as State,
    mask, soft, veto: {}, audit: [], hookEvents: [], txDepth: 0,
  };
  const hooks = Object.fromEntries(tables.map(table => [table, {
    beforeDelete: (id: number) => {
      if (env.veto.table === table && env.veto.id === id) {
        if (env.veto.mode === "throw") throw new Error("matrix-veto");
        return false;
      }
    },
    beforeRestore: (id: number) => {
      if (env.veto.table === table && env.veto.id === id) {
        if (env.veto.mode === "throw") throw new Error("matrix-veto");
        return false;
      }
    },
    afterDelete: (id: number) => {
      const event = `delete:${table}:${id}`;
      env.db.audit.insert({ event });
      env.hookEvents.push(event);
    },
    afterRestore: (id: number) => {
      const event = `restore:${table}:${id}`;
      env.db.audit.insert({ event });
      env.hookEvents.push(event);
    },
  }]));
  env.db = new Database(":memory:", schemas, {
    softDeletes: soft, reactive: false,
    relations: rel, cascade: cascade(mask), hooks,
  } as any);
  // The fixture has four relation levels, a self-reference, and a join table.
  for (const [table, data] of [
    ["orgs", { name: "org", score: 1 }],
    ["projects", { name: "project", score: 1, orgId: 1 }],
    ["tasks", { name: "task", score: 1, projectId: 1, parentId: null }],
    ["tasks", { name: "subtask", score: 1, projectId: 1, parentId: 1 }],
    ["notes", { name: "note", score: 1, taskId: 2 }],
    ["tags", { name: "tag", score: 1 }],
    ["taskTags", { name: "link", score: 1, taskId: 2, tagId: 1 }],
  ] as [Table, Record<string, any>][]) {
    const entity = env.db[table].insert(data);
    env.state[table].push({ id: entity.id, ...data, ...(soft ? { deletedAt: null } : {}) } as Row);
  }
  return env;
}
function row(env: Env, t: Table, id: number) { return env.state[t].find(r => r.id === id); }
function live(env: Env, t: Table) { return env.state[t].filter(r => !env.soft || r.deletedAt == null); }
function linked(env: Env, child: Table, parent: Table, id: number): Row[] {
  const fks = Object.entries(rel[child] ?? {}).filter(([_, p]) => p === parent).map(([f]) => f);
  return live(env, child).filter(r => fks.some(k => r[k] === id));
}
function descendants(env: Env, t: Table, id: number): [Table, Row][] {
  const seen = new Set<string>(), result: [Table, Row][] = [];
  function walk(table: Table, item: Row) {
    const key = `${table}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.forEach(([parent, child], bit) => {
      if (parent === table && (env.mask & (1 << bit)))
        for (const r of linked(env, child, parent, item.id)) walk(child, r);
    });
    result.push([table, item]); // postorder, like the public cascade contract
  }
  const root = row(env, t, id);
  if (root && (!env.soft || root.deletedAt == null)) walk(t, root);
  return result;
}
function restoring(env: Env, t: Table, id: number): [Table, Row][] {
  const root = row(env, t, id);
  if (!root) throw new Error("row not found");
  if (root.deletedAt == null) return [];
  const stamp = root.deletedAt, seen = new Set<string>(), result: [Table, Row][] = [];
  function walk(table: Table, item: Row) {
    if (seen.has(`${table}:${item.id}`)) return;
    seen.add(`${table}:${item.id}`);
    result.push([table, item]);
    edges.forEach(([parent, child], bit) => {
      if (parent !== table || !(env.mask & (1 << bit))) return;
      for (const r of env.state[child])
        if (r.deletedAt === stamp && Object.entries(rel[child] ?? {})
          .some(([fk, target]) => target === parent && r[fk] === item.id))
          walk(child, r);
    });
  }
  walk(t, root);
  for (const [table, item] of result) for (const [fk, parent] of Object.entries(rel[table] ?? {})) {
    const parentId = item[fk];
    if (parentId == null) continue;
    const p = row(env, parent, parentId);
    if (!p || (p.deletedAt != null && !seen.has(`${parent}:${parentId}`)))
      throw new Error("parent deleted or missing");
  }
  return result;
}
// The documented relation DDL uses ON DELETE SET NULL for physical deletes.
// This applies even when the application cascade edge is disabled.
function detachReferences(env: Env, removed: [Table, number][]) {
  for (const [parent, id] of removed)
    for (const child of tables)
      for (const [fk, target] of Object.entries(rel[child] ?? {}))
        if (target === parent)
          for (const r of env.state[child])
            if (r[fk] === id) r[fk] = null;
}
function fullDump(db: any): Record<string, any[]> {
  return Object.fromEntries([...tables, "audit"].map(t =>
    [t, db.raw(`SELECT * FROM "${t}" ORDER BY id`)]));
}
function check(env: Env) {
  for (const t of tables) {
    const got = (env.db.raw(`SELECT * FROM "${t}" ORDER BY id`) as Row[]);
    expect(got).toEqual(sorted(env.state[t]));
    const expected = sorted(live(env, t));
    const actual = env.db[t].select().all().map((r: any) =>
      Object.fromEntries(Object.keys(expected[0] ?? { id: 0 }).map(k => [k, r[k]])));
    expect(actual).toEqual(expected);
    expect(env.db[t].count()).toBe(expected.length);
    expect(env.db[t].select().count()).toBe(expected.length);
    for (const r of env.state[t]) {
      const found = env.db[t].get(r.id);
      if (env.soft && r.deletedAt != null) expect(found).toBeNull();
      else expect(found && Object.fromEntries(Object.keys(r).map(k => [k, found[k]]))).toEqual(r);
    }
  }
  const committedAudit = (env.db.raw('SELECT event FROM "audit" ORDER BY id') as any[])
    .map(r => r.event);
  // after-hooks now run after the outermost commit; audit writes from a
  // pending savepoint/transaction cannot yet be visible.
  if (env.txDepth > 0)
    expect(committedAudit).toEqual(env.audit.slice(0, committedAudit.length));
  else
    expect(committedAudit).toEqual(env.audit);
  // Relationship accessors and eager loading must hide soft-deleted children.
  const org = env.db.orgs.get(1);
  if (org) {
    const children = (org as any).projects();
    expect(children.map((r: any) => r.id).sort()).toEqual(
      linked(env, "projects", "orgs", 1).map(r => r.id).sort());
    const eager = env.db.orgs.select().where({ id: 1 }).with("projects").get();
    expect((eager?.projects ?? []).map((r: any) => r.id).sort())
      .toEqual(children.map((r: any) => r.id).sort());
  }
  for (const task of live(env, "tasks")) {
    const entity = env.db.tasks.get(task.id);
    if (entity && task.parentId != null)
      expect((entity as any).parentIdRelation()?.id ?? null)
        .toEqual(env.db.tasks.get(task.parentId)?.id ?? null);
  }
}
function apply(env: Env, op: Op): void {
  if (op.kind === "tx") {
    const snapshot = clone(env.state), audit = [...env.audit];
    const before = fullDump(env.db);
    try {
      env.db.transaction(() => {
        env.txDepth++;
        try {
          for (const inner of op.ops ?? []) apply(env, inner);
          if (op.fail) throw new Error("matrix-abort");
        } finally {
          env.txDepth--;
        }
      });
    } catch (e) {
      env.state = snapshot; env.audit = audit;
      expect(fullDump(env.db)).toEqual(before);
      if (!op.fail && !String(e).match(/constraint|veto|Cascade cancelled|parent|restore/i)) throw e;
    }
    check(env);
    return;
  }
  const t = op.table!, id = op.id!, target = row(env, t, id);
  const before = fullDump(env.db), previous = clone(env.state), audit = [...env.audit];
  env.veto = op.veto && op.table
    ? { table: op.vetoTable ?? t, id: op.vetoId ?? id, mode: op.veto } : {};
  try {
    switch (op.kind) {
      case "insert": {
        const data = { name: op.name!, score: op.score ?? 0, ...op.fk };
        const created = env.db[t].insert(data);
        env.state[t].push({ id: created.id, ...data, ...(env.soft ? { deletedAt: null } : {}) });
        break;
      }
      case "update":
        env.db[t].update(id, { score: op.score });
        if (target && (!env.soft || target.deletedAt == null)) target.score = op.score!;
        break;
      case "updateWhere":
        env.db[t].update({ score: op.score }).where({ name: op.name }).exec();
        for (const r of live(env, t)) if (r.name === op.name) r.score = op.score!;
        break;
      case "upsert": {
        const existing = env.state[t].find(r => r.name === op.name);
        // With no row to match, upsert inserts { name, score }; tables with a
        // required foreign key reject that row (validation, nothing written).
        if (!existing && Object.keys(rel[t] ?? {}).some(key => key !== "parentId")) {
          expect(() => env.db[t].upsert({ name: op.name }, { score: op.score })).toThrow();
          break;
        }
        if (existing?.deletedAt != null) {
          const cohort = restoring(env, t, existing.id);
          for (const [table, item] of cohort.reverse()) {
            item.deletedAt = null;
            env.audit.push(`restore:${table}:${item.id}`);
          }
        }
        const result = env.db[t].upsert({ name: op.name }, { score: op.score });
        if (existing) existing.score = op.score!;
        else env.state[t].push({ id: result.id, name: op.name!, score: op.score!, ...(env.soft ? { deletedAt: null } : {}), ...op.fk });
        break;
      }
      case "delete": {
        const group = descendants(env, t, id);
        const vetoed = op.veto && group.some(([table, item]) =>
          table === env.veto.table && item.id === env.veto.id);
        const mustThrow = vetoed && (op.veto === "throw" ||
          env.veto.table !== t || env.veto.id !== id);
        if (mustThrow) {
          expect(() => env.db[t].delete(id)).toThrow();
          break;
        }
        env.db[t].delete(id);
        if (vetoed && op.veto === "false") break;
        // Once SQLite commits its cascade, its root timestamp identifies this
        // cohort; this is not used to choose which rows belong to the cohort.
        const stamp = env.soft
          ? (env.db.raw(`SELECT "deletedAt" FROM "${t}" WHERE id = ?`, id) as any[])[0]?.deletedAt
          : null;
        for (const [table, item] of group) {
          if (env.soft) item.deletedAt = stamp;
          else env.state[table] = env.state[table].filter(r => r.id !== item.id);
          env.audit.push(`delete:${table}:${item.id}`);
        }
        if (!env.soft) detachReferences(env, group.map(([table, item]) => [table, item.id]));
        break;
      }
      case "restore": {
        const cohort = restoring(env, t, id);
        env.db[t].restore(id);
        if (!op.veto) for (const [table, item] of cohort.reverse()) {
          item.deletedAt = null;
          env.audit.push(`restore:${table}:${item.id}`);
        }
        break;
      }
      case "deleteWhere": {
        env.db[t].delete().where({ name: op.name }).exec();
        for (const r of [...live(env, t)].filter(r => r.name === op.name)) {
          if (env.soft) r.deletedAt = (env.db.raw(`SELECT "deletedAt" FROM "${t}" WHERE id = ?`, r.id) as any[])[0].deletedAt;
          else {
            env.state[t] = env.state[t].filter(x => x.id !== r.id);
            detachReferences(env, [[t, r.id]]);
          }
        }
        break;
      }
      case "hard": {
        env.db.exec(`DELETE FROM "${t}" WHERE id = ${id} AND "deletedAt" IS NOT NULL`);
        if (target?.deletedAt != null) {
          env.state[t] = env.state[t].filter(r => r.id !== id);
          detachReferences(env, [[t, id]]);
        }
        break;
      }
      default: throw new Error(`Unknown matrix operation ${op.kind}`);
    }
  } catch (e) {
    env.state = previous; env.audit = audit;
    // A failed operation must have left all stored data untouched.
    expect(fullDump(env.db)).toEqual(before);
    if (!/constraint|veto|Cascade cancelled|parent|row not found|restore/i.test(String(e))) throw e;
  } finally { env.veto = {}; }
  check(env);
}
function generate(env: Env, rng: () => number, iteration: number): Op {
  const pick = <T,>(items: T[]): T => items[Math.floor(rng() * items.length)]!;
  const t = pick(tables);
  const rows = env.state[t], liveRows = live(env, t);
  const selected = pick(liveRows.length ? liveRows : rows.length ? rows : [{ id: 99999, name: "missing" } as Row]);
  const score = iteration + 10, name = selected.name;
  const choices = ["update", "updateWhere", "upsert", "delete", "deleteWhere", "insert", "restore"];
  if (env.soft) choices.push("hard");
  const kind = pick(choices);
  if (!rows.length && kind === "upsert") return { kind: "update", table: t, id: 99999, score };
  if (kind === "insert") {
    const fk: Record<string, number | null> = {};
    for (const [key, parent] of Object.entries(rel[t] ?? {})) {
      const parentRows = live(env, parent);
      if (key === "parentId") fk[key] = null;
      else if (!parentRows.length) return { kind: "update", table: t, id: selected.id, score };
      else fk[key] = pick(parentRows).id;
    }
    return { kind, table: t, name: `${t}-${iteration}-${Math.floor(rng()*1e6)}`, score, fk };
  }
  if (kind === "restore") return { kind, table: t,
    id: pick(rows.length ? rows : [selected]).id,
    ...(rng() < 0.2 ? { veto: rng() < 0.5 ? "false" as const : "throw" as const } : {}) };
  if (kind === "hard" && (!rows.length || !rows.some(r => r.deletedAt != null)))
    return { kind: "update", table: t, id: selected.id, score };
  if (kind === "hard") return { kind, table: t, id: pick(rows.filter(r => r.deletedAt != null)).id };
  if (kind === "deleteWhere") {
    // Bulk writes intentionally bypass hooks/cascades. Delete leaf tables only.
    const leaf = pick(["notes", "taskTags"] as Table[]);
    const r = pick(live(env, leaf));
    return r ? { kind, table: leaf, name: r.name } : { kind: "update", table: t, id: selected.id, score };
  }
  if (kind === "delete" && rng() < 0.3) {
    const group = descendants(env, t, selected.id);
    const victim = group.length > 1 && rng() < 0.55 ? pick(group.slice(0, -1)) : [t, selected] as [Table, Row];
    return { kind, table: t, id: selected.id,
      vetoTable: victim[0], vetoId: victim[1].id,
      veto: rng() < 0.5 ? "false" : "throw" };
  }
  return { kind, table: t, id: selected.id, name, score };
}
function replay(seed: number, mask: number, soft: boolean, ops?: Op[]): void {
  const env = make(mask, soft), rng = random(seed);
  const history: Op[] = [];
  try {
    check(env);
    const length = 1 + Math.floor(rng() * 30);
    for (let i = 0; i < (ops?.length ?? length); i++) {
      const op = ops?.[i] ?? (rng() < 0.15
        ? { kind: "tx", ops: Array.from({ length: 1 + Math.floor(rng() * 5) },
            (_, j) => generate(env, rng, i * 5 + j)), fail: rng() < 0.35 }
        : generate(env, rng, i));
      history.push(op);
      apply(env, op);
    }
  } catch (e) {
    const error = String(e);
    const reproduces = (candidate: Op[]) => {
      try { replayOnce(seed, mask, soft, candidate); return false; }
      catch (x) { return String(x) === error; }
    };
    let minimal = history.slice(), granularity = 2;
    while (minimal.length > 1) {
      const size = Math.ceil(minimal.length / granularity);
      let reduced = false;
      for (let i = 0; i < minimal.length; i += size) {
        const attempt = minimal.filter((_, j) => j < i || j >= i + size);
        if (attempt.length && reproduces(attempt)) {
          minimal = attempt; granularity = Math.max(2, granularity - 1); reduced = true; break;
        }
      }
      if (!reduced) { if (granularity >= minimal.length) break; granularity = Math.min(minimal.length, granularity * 2); }
    }
    throw new Error(`seed=${seed} mask=${mask} soft=${soft}\n${error}\nminimal operations:\n${JSON.stringify(minimal, null, 2)}`, { cause: e });
  } finally { env.db.close(); }
}
function replayOnce(seed: number, mask: number, soft: boolean, ops: Op[]) {
  const env = make(mask, soft);
  try { check(env); for (const op of ops) apply(env, op); }
  finally { env.db.close(); }
}
const seedFilter = process.env.MATRIX_SEED, maskFilter = process.env.MATRIX_MASK, softFilter = process.env.MATRIX_SOFT;
test("startup rejects unknown and unlinked cascade entries", () => {
  expect(() => new Database(":memory:", schemas, { cascade: { missing: ["notes"] } } as any)).toThrow(/unknown table/);
  expect(() => new Database(":memory:", schemas, { cascade: { orgs: ["notes"] }, relations: rel } as any)).toThrow(/no relation/);
});
for (const soft of [false, true]) for (let mask = 0; mask < 64; mask++) for (let index = 0; index < 16; index++) {
  if (softFilter != null && Number(softFilter) !== Number(soft)) continue;
  if (maskFilter != null && Number(maskFilter) !== mask) continue;
  const seed = (0x9e3779b9 ^ (mask * 0x85ebca6b) ^ (index * 0x27d4eb2d)) >>> 0;
  if (seedFilter != null && Number(seedFilter) !== seed) continue;
  test(`state machine seed=${seed} cascade=${mask} soft=${soft}`, () => replay(seed, mask, soft));
}
test("regression: upsert must not resurrect a child of a deleted parent", () => {
  const db: any = new Database(":memory:", {
    parents: z.object({ name: z.string() }),
    children: z.object({ name: z.string(), parentId: z.number() }),
  }, { softDeletes: true, reactive: false,
    relations: { children: { parentId: "parents" } }, cascade: { parents: ["children"] } });
  try {
    const p = db.parents.insert({ name: "p" });
    const c = db.children.insert({ name: "c", parentId: p.id });
    db.parents.delete(p.id);
    const before = db.raw('SELECT * FROM "children"');
    expect(() => db.children.upsert({ name: "c" }, { name: "new" })).toThrow(/parent/);
    expect(db.raw('SELECT * FROM "children"')).toEqual(before);
  } finally { db.close(); }
});
test("regression: independent delete events cannot share a restore cohort", () => {
  const db: any = new Database(":memory:", {
    parents: z.object({ name: z.string() }),
    children: z.object({ name: z.string(), parentId: z.number() }),
  }, { softDeletes: true, reactive: false,
    relations: { children: { parentId: "parents" } }, cascade: { parents: ["children"] } });
  try {
    const p = db.parents.insert({ name: "p" });
    const a = db.children.insert({ name: "a", parentId: p.id });
    const b = db.children.insert({ name: "b", parentId: p.id });
    const OriginalDate = Date;
    // Freeze the clock: two independent deletions in the same millisecond.
    const fixed = OriginalDate.parse("2026-01-01T00:00:00.000Z");
    class FrozenDate extends OriginalDate {
      constructor(...args: any[]) {
        super(args.length ? args[0] : fixed);
      }
      static now() { return fixed; }
    }
    globalThis.Date = FrozenDate as DateConstructor;
    try {
      db.children.delete(a.id);
    const first = db.raw('SELECT "deletedAt" FROM "children" WHERE id = ?', a.id)[0].deletedAt;
    db.parents.delete(p.id);
    const second = db.raw('SELECT "deletedAt" FROM "parents" WHERE id = ?', p.id)[0].deletedAt;
    expect(first).not.toBe(second);
    db.parents.restore(p.id);
    expect(db.children.get(a.id)).toBeNull();
    expect(db.children.get(b.id)).not.toBeNull();
    } finally { globalThis.Date = OriginalDate; }
  } finally { db.close(); }
});
test("regression: grandchild veto aborts a four-level cascade inside an outer transaction", () => {
  let db: any;
  const seen: string[] = [];
  db = new Database(":memory:", {
    orgs: z.object({ name: z.string() }),
    projects: z.object({ name: z.string(), orgId: z.number() }),
    tasks: z.object({ name: z.string(), projectId: z.number() }),
    notes: z.object({ name: z.string(), taskId: z.number() }),
    log: z.object({ entry: z.string() }),
  }, {
    softDeletes: true, reactive: false,
    relations: { projects: { orgId: "orgs" }, tasks: { projectId: "projects" }, notes: { taskId: "tasks" } },
    cascade: { orgs: ["projects"], projects: ["tasks"], tasks: ["notes"] },
    hooks: {
      notes: { beforeDelete: () => false },
      tasks: { afterDelete: () => { seen.push("after"); db.log.insert({ entry: "deleted" }); } },
    },
  });
  try {
    const org = db.orgs.insert({ name: "x" });
    const project = db.projects.insert({ name: "x", orgId: org.id });
    const task = db.tasks.insert({ name: "x", projectId: project.id });
    db.notes.insert({ name: "x", taskId: task.id });
    const snapshot = Object.fromEntries(["orgs","projects","tasks","notes","log"].map(
      table => [table, db.raw(`SELECT * FROM "${table}" ORDER BY id`)]));
    expect(() => db.transaction(() => {
      db.log.insert({ entry: "temporary" });
      db.orgs.delete(org.id);
    })).toThrow(/Cascade cancelled/);
    expect(Object.fromEntries(["orgs","projects","tasks","notes","log"].map(
      table => [table, db.raw(`SELECT * FROM "${table}" ORDER BY id`)]))).toEqual(snapshot);
    expect(seen).toEqual([]);
  } finally { db.close(); }
});
test("listener receives committed insertion but not rolled-back insertion", async () => {
  const db: any = new Database(":memory:", { items: z.object({ name: z.string() }) },
    { reactive: true, pollInterval: 5 });
  const events: string[] = [];
  const unsubscribe = db.items.on("insert", (item: any) => events.push(item.name));
  try {
    expect(() => db.transaction(() => {
      db.items.insert({ name: "rolled-back" });
      throw new Error("abort");
    })).toThrow("abort");
    db.items.insert({ name: "committed" });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(events).toEqual(["committed"]);
  } finally { unsubscribe(); db.close(); }
});
test("regression: upsert that revives a row and then fails runs no afterRestore hook", () => {
  const events: string[] = [];
  const db: any = new Database(":memory:", {
    items: z.object({ name: z.string(), score: z.number() }),
  }, { softDeletes: true, reactive: false,
    hooks: { items: { afterRestore: (id: number) => { events.push(`restore:${id}`); } } } });
  try {
    const item = db.items.insert({ name: "a", score: 1 });
    db.items.delete(item.id);
    const before = db.raw('SELECT * FROM "items"');
    // The revive succeeds, then the update fails validation: everything rolls back.
    expect(() => db.items.upsert({ name: "a" }, { score: "not a number" })).toThrow();
    expect(db.raw('SELECT * FROM "items"')).toEqual(before);
    expect(events).toEqual([]);
    db.items.upsert({ name: "a" }, { score: 2 });
    expect(events).toEqual([`restore:${item.id}`]);
  } finally { db.close(); }
});
