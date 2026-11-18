/**
 * crud.ts — CRUD operations extracted from Database class.
 *
 * Each function accepts a `DatabaseContext` so it can access
 * the db handle, schemas, and entity methods without tight coupling.
 */
import type { AugmentedEntity, UpdateBuilder, DeleteBuilder } from "./types";
import { asZodObject } from "./types";
import { transformForStorage, transformFromStorage } from "./schema";
import type { DatabaseContext } from "./context";

function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// A restoration cohort must not accidentally share a millisecond with another delete.
let lastDeleteMillisecond = 0;
function deletionTimestamp(): string {
  lastDeleteMillisecond = Math.max(Date.now(), lastDeleteMillisecond + 1);
  return new Date(lastDeleteMillisecond).toISOString();
}

const activeHooks = new WeakMap<object, Set<string>>();

/** Lifecycle hooks are synchronous. Reject promises and same-hook re-entry. */
export function invokeHookSync<T>(
  ctx: DatabaseContext,
  entityName: string,
  hookName: string,
  hook: () => T,
): T {
  let active = activeHooks.get(ctx);
  if (!active) {
    active = new Set();
    activeHooks.set(ctx, active);
  }
  const key = `${entityName}:${hookName}`;
  if (active.has(key))
    throw new Error(`Recursive lifecycle hook ${entityName}.${hookName} is not supported`);

  active.add(key);
  try {
    const result = hook();
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as any).then === "function"
    ) {
      if (hookName.startsWith("after")) {
        // The write is already done: an async after-hook is fire-and-forget,
        // but its rejection must not go unhandled.
        Promise.resolve(result).catch((error) => {
          console.error(`[sqlite-zod-orm] ${entityName}.${hookName} hook failed:`, error);
        });
        return result;
      }
      // A before-hook decides the write (beforeDelete returning false cancels
      // it); a Promise cannot be awaited by this synchronous API, so refuse it.
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError(
        `Lifecycle hook ${entityName}.${hookName} must be synchronous`,
      );
    }
    return result;
  } finally {
    active.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function visibleWhere(ctx: DatabaseContext, table: string, clause: string, trashed = false): string {
  if (!ctx.softDeletes || ctx.viewNames.has(table) || trashed) return clause;
  return `${clause}${clause ? " AND" : "WHERE"} "deletedAt" IS NULL`;
}

export function getById(
  ctx: DatabaseContext,
  entityName: string,
  id: number,
  includeDeleted = false,
): AugmentedEntity<any> | null {
  const row = ctx
    ._stmt(`SELECT * FROM ${qi(entityName)} ${visibleWhere(ctx, entityName, "WHERE id = ?", includeDeleted)}`)
    .get(id) as any;
  if (!row) return null;
  return ctx.attachMethods(
    entityName,
    transformFromStorage(row, ctx.schemas[entityName]!),
  );
}

export function getOne(
  ctx: DatabaseContext,
  entityName: string,
  conditions: Record<string, any>,
  includeDeleted = false,
): AugmentedEntity<any> | null {
  const { clause, values } = ctx.buildWhereClause(conditions);
  const row = ctx
    ._stmt(`SELECT * FROM ${qi(entityName)} ${visibleWhere(ctx, entityName, clause, includeDeleted)} LIMIT 1`)
    .get(...values) as any;
  if (!row) return null;
  return ctx.attachMethods(
    entityName,
    transformFromStorage(row, ctx.schemas[entityName]!),
  );
}

export function findMany(
  ctx: DatabaseContext,
  entityName: string,
  conditions: Record<string, any> = {},
): AugmentedEntity<any>[] {
  const { clause, values } = ctx.buildWhereClause(conditions);
  const rows = ctx
    ._stmt(`SELECT * FROM ${qi(entityName)} ${visibleWhere(ctx, entityName, clause)}`)
    .all(...values);
  return rows.map((row: any) =>
    ctx.attachMethods(
      entityName,
      transformFromStorage(row, ctx.schemas[entityName]!),
    ),
  );
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

function executeInsert<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  data: Omit<T, "id">,
  deferAfterHook = false,
): AugmentedEntity<any> {
  const schema = ctx.schemas[entityName]!;
  let inputData = { ...data } as Record<string, any>;

  // beforeInsert hook — can transform data
  const hooks = ctx.hooks[entityName];
  if (hooks?.beforeInsert) {
    const result = invokeHookSync(
      ctx, entityName, "beforeInsert", () => hooks.beforeInsert!(inputData),
    );
    if (result) inputData = result;
  }

  const validatedData = asZodObject(schema).passthrough().parse(inputData);
  const transformed = transformForStorage(validatedData, schema);

  // Auto-inject timestamps
  if (ctx.timestamps) {
    const now = new Date().toISOString();
    transformed.createdAt = now;
    transformed.updatedAt = now;
  }

  const columns = Object.keys(transformed);

  const quotedCols = columns.map(qi);
  const sql =
    columns.length === 0
      ? `INSERT INTO ${qi(entityName)} DEFAULT VALUES`
      : `INSERT INTO ${qi(entityName)} (${quotedCols.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;

  let lastId = 0;
  ctx._m(`SQL: ${sql.slice(0, 40)}`, () => {
    const result = ctx._stmt(sql).run(...Object.values(transformed));
    lastId = result.lastInsertRowid as number;
  });
  const newEntity = getById(ctx, entityName, lastId);
  if (!newEntity) throw new Error("Failed to retrieve entity after insertion");

  // afterInsert hook
  if (!deferAfterHook && hooks?.afterInsert)
    ctx._afterCommit(() => invokeHookSync(ctx, entityName, "afterInsert", () =>
      hooks.afterInsert!(newEntity)));

  return newEntity;
}

export function insert<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  data: Omit<T, "id">,
): AugmentedEntity<any> {
  return executeInsert(ctx, entityName, data);
}

export function update<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  id: number,
  data: Partial<Omit<T, "id">>,
  deferAfterHook = false,
  recordWrite?: (wrote: boolean) => void,
): AugmentedEntity<any> | null {
  const schema = ctx.schemas[entityName]!;
  let inputData = { ...data } as Record<string, any>;

  // beforeUpdate hook — can transform data. It runs only for a row the
  // update can reach (a soft-deleted row is not updated, so no hook either).
  const hooks = ctx.hooks[entityName];
  if (hooks?.beforeUpdate && getById(ctx, entityName, id)) {
    const result = invokeHookSync(
      ctx, entityName, "beforeUpdate", () => hooks.beforeUpdate!(inputData, id),
    );
    if (result) inputData = result;
  }

  const validatedData = parsePartial(schema, inputData);
  const transformed = transformForStorage(validatedData, schema);
  // An empty update is a read, not a physical write or an afterUpdate.
  if (Object.keys(transformed).length === 0) {
    recordWrite?.(false);
    return getById(ctx, entityName, id);
  }

  // Auto-update timestamp
  if (ctx.timestamps) {
    transformed.updatedAt = new Date().toISOString();
  }

  const setClause = Object.keys(transformed)
    .map((key) => `${qi(key)} = ?`)
    .join(", ");
  const sql = `UPDATE ${qi(entityName)} SET ${setClause} ${visibleWhere(ctx, entityName, "WHERE id = ?")}`;
  const affected = ctx._m(`SQL: UPDATE ${entityName} SET ...`, () => {
    ctx._stmt(sql).run(...Object.values(transformed), id);
    return statementChanges(ctx);
  });

  recordWrite?.(affected > 0);
  const updated = getById(ctx, entityName, id);

  // A missing/tombstoned row must not produce an after-hook.
  if (!deferAfterHook && affected > 0 && hooks?.afterUpdate && updated)
    ctx._afterCommit(() => invokeHookSync(ctx, entityName, "afterUpdate", () =>
      hooks.afterUpdate!(updated)));

  return updated;
}

/**
 * Rows changed by the statement just run. Bun's `run().changes` also counts
 * rows written by triggers (the change journal), which doubled every bulk
 * count; SQLite's changes() counts only the statement's own table.
 */
function statementChanges(ctx: DatabaseContext): number {
  return (ctx._stmt("SELECT changes() AS n").get() as { n: number }).n;
}

/** Bulk SQL update: deliberately bypasses per-row beforeUpdate/afterUpdate hooks. */
export function updateWhere(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
  conditions: Record<string, any>,
): number {
  const schema = ctx.schemas[entityName]!;
  const validatedData = parsePartial(schema, data);
  const transformed = transformForStorage(validatedData, schema);
  if (Object.keys(transformed).length === 0) return 0;
  if (ctx.timestamps) transformed.updatedAt = new Date().toISOString();

  const { clause, values: whereValues } = ctx.buildWhereClause(conditions);
  if (!clause)
    throw new Error("update().where() requires at least one condition");

  const setCols = Object.keys(transformed);
  const setClause = setCols.map((key) => `${qi(key)} = ?`).join(", ");
  ctx
    ._stmt(`UPDATE ${qi(entityName)} SET ${setClause} ${visibleWhere(ctx, entityName, clause)}`)
    .run(...setCols.map((key) => transformed[key]), ...whereValues);

  return statementChanges(ctx);
}

export function createUpdateBuilder(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
): UpdateBuilder<any> {
  let _conditions: Record<string, any> = {};
  const builder: UpdateBuilder<any> = {
    where: (conditions) => {
      _conditions = { ..._conditions, ...conditions };
      return builder;
    },
    exec: () => updateWhere(ctx, entityName, data, _conditions),
  };
  return builder;
}

export function upsert<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  data: any,
  conditions: any = {},
): AugmentedEntity<any> {
  // Reserve the write lock BEFORE reading. A deferred transaction permits
  // two connections to both observe a missing row and race to insert it.
  let restored: [string, number][] = [];
  const txn = () => {
    const hasId = typeof data?.id === "number";
    const existing = hasId
      ? getById(ctx, entityName, data.id, true)
      : Object.keys(conditions ?? {}).length > 0
        ? getOne(ctx, entityName, conditions, true)
        : null;

    if (existing) {
      // Reuse the unique key rather than inserting into a retained unique index.
      if (ctx.softDeletes && existing.deletedAt != null) {
        // Upsert may revive a tombstone, but cannot bypass restore's orphan,
        // cohort, or beforeRestore checks.
        restored = restoreRows(ctx, entityName, existing.id);
        if (!getById(ctx, entityName, existing.id))
          throw new Error(`Cannot upsert ${entityName}(${existing.id}): restore was vetoed`);
      }
      const updateData = { ...data };
      delete updateData.id;
      let wrote = false;
      const entity = update(
        ctx,
        entityName,
        existing.id,
        updateData,
        true,
        (changed) => { wrote = changed; },
      );
      if (!entity) throw new Error("Failed to retrieve entity after upsert");
      return { entity, created: false, wrote };
    }

    const insertData = { ...(conditions ?? {}), ...(data ?? {}) };
    delete insertData.id;
    return {
      entity: executeInsert(ctx, entityName, insertData, true),
      created: true,
      wrote: true,
    };
  };

  const result = ctx._transaction(txn);
  runAfterRestore(ctx, restored);

  // After-hooks must describe committed changes, never rolled-back ones.
  const hooks = ctx.hooks[entityName];
  if (result.created && hooks?.afterInsert)
    ctx._afterCommit(() => invokeHookSync(ctx, entityName, "afterInsert", () =>
      hooks.afterInsert!(result.entity)));
  else if (!result.created && result.wrote && hooks?.afterUpdate)
    ctx._afterCommit(() => invokeHookSync(ctx, entityName, "afterUpdate", () =>
      hooks.afterUpdate!(result.entity)));

  return result.entity;
}

/** Find a row matching conditions, or create it with the merged data. Returns { entity, created }. */
export function findOrCreate<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  conditions: Record<string, any>,
  defaults: Record<string, any> = {},
): { entity: AugmentedEntity<any>; created: boolean } {
  // The existence check and insert must hold the same write reservation.
  return ctx._transaction(() => {
    const existing = getOne(ctx, entityName, conditions);
    if (existing) return { entity: existing, created: false };
    // Conditions must remain true of the newly created row, even if defaults
    // happen to include the same key.
    const data = { ...defaults, ...conditions };
    delete (data as any).id;
    return { entity: executeInsert(ctx, entityName, data), created: true };
  });
}

export function deleteEntity(
  ctx: DatabaseContext,
  entityName: string,
  id: number,
): void {
  const now = deletionTimestamp();
  const deleted: [string, number][] = [];
  const visited = new Set<string>();

  // Parent first: its beforeDelete runs (and may veto) before any child's.
  // Children are deleted before their parent; every row is visited once,
  // so self-references and table cycles terminate.
  const visit = (table: string, rowId: number, isRoot: boolean): boolean => {
    const key = `${table}:${rowId}`;
    if (visited.has(key)) return true;
    visited.add(key);
    if (!getById(ctx, table, rowId)) return false;
    const hooks = ctx.hooks[table];
    if (hooks?.beforeDelete) {
      const verdict = invokeHookSync(ctx, table, "beforeDelete", () => hooks.beforeDelete!(rowId));
      if (verdict === false) {
        if (isRoot) return false; // the caller's own veto: nothing happens
        throw new Error(`Cascade cancelled: ${table}.beforeDelete(${rowId}) returned false`);
      }
    }
    for (const child of ctx.cascade[table] ?? []) {
      const rels = ctx.relationships.filter(
        (r) => r.type === "belongs-to" && r.from === child && r.to === table,
      );
      for (const rel of rels) {
        const rows = ctx
          ._stmt(
            `SELECT id FROM ${qi(child)} WHERE ${qi(rel.foreignKey)} = ?${ctx.softDeletes ? ' AND "deletedAt" IS NULL' : ""}`,
          )
          .all(rowId) as { id: number }[];
        for (const row of rows) visit(child, row.id, false);
      }
    }
    const result = ctx.softDeletes
      ? ctx._stmt(`UPDATE ${qi(table)} SET "deletedAt" = ? WHERE id = ? AND "deletedAt" IS NULL`).run(now, rowId)
      : ctx._stmt(`DELETE FROM ${qi(table)} WHERE id = ?`).run(rowId);
    if (statementChanges(ctx) > 0) deleted.push([table, rowId]);
    return true;
  };

  ctx._transaction(() => {
    visit(entityName, id, true);
  });

  // After-hooks describe committed deletes, children first.
  for (const [table, rowId] of deleted) {
    const hooks = ctx.hooks[table];
    if (hooks?.afterDelete)
      ctx._afterCommit(() => invokeHookSync(ctx, table, "afterDelete", () =>
        hooks.afterDelete!(rowId)));
  }
}

/** Restore only descendants bearing the root's cascade-delete timestamp. */
export function restoreEntity(ctx: DatabaseContext, entityName: string, id: number): void {
  runAfterRestore(ctx, restoreRows(ctx, entityName, id));
}

/** afterRestore hooks, children first; call only once the restore is committed. */
function runAfterRestore(ctx: DatabaseContext, rows: [string, number][]): void {
  for (const [table, rowId] of rows) {
    const hook = ctx.hooks[table]?.afterRestore;
    if (hook) ctx._afterCommit(() =>
      invokeHookSync(ctx, table, "afterRestore", () => hook(rowId)));
  }
}

/** Restore a row and its cohort; returns the restored rows (children first) without running after-hooks. */
function restoreRows(ctx: DatabaseContext, entityName: string, id: number): [string, number][] {
  const rows: [string, number][] = [];
  const seen = new Set<string>();
  ctx._transaction(() => {
    const root = ctx._stmt(`SELECT "deletedAt" FROM ${qi(entityName)} WHERE id = ?`)
      .get(id) as { deletedAt: string | null } | null;
    if (!root) throw new Error(`Cannot restore ${entityName}(${id}): row not found`);
    if (root.deletedAt === null) return; // already live: no hooks
    const stamp = root.deletedAt;
    const visit = (table: string, rowId: number) => {
      const key = `${table}:${rowId}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push([table, rowId]); // root first; cycles terminate
      for (const child of ctx.cascade[table] ?? [])
        for (const rel of ctx.relationships.filter(
          (r) => r.type === "belongs-to" && r.from === child && r.to === table,
        )) {
          const matches = ctx._stmt(
            `SELECT id FROM ${qi(child)} WHERE ${qi(rel.foreignKey)} = ? AND "deletedAt" = ?`,
          ).all(rowId, stamp) as { id: number }[];
          for (const match of matches) visit(child, match.id);
        }
    };
    visit(entityName, id);

    // Every restored row must have a live or simultaneously restored parent.
    for (const [table, rowId] of rows)
      for (const rel of ctx.relationships.filter(
        (r) => r.type === "belongs-to" && r.from === table,
      )) {
        const parent = ctx._stmt(
          `SELECT c.${qi(rel.foreignKey)} AS parentId, p.id AS found, ` +
          `p."deletedAt" AS deletedAt FROM ${qi(table)} c ` +
          `LEFT JOIN ${qi(rel.to)} p ON p.id = c.${qi(rel.foreignKey)} WHERE c.id = ?`,
        ).get(rowId) as { parentId: number | null; found: number | null; deletedAt: string | null };
        if (parent.parentId !== null &&
            (parent.found === null || (parent.deletedAt !== null &&
              !seen.has(`${rel.to}:${parent.parentId}`))))
          throw new Error(`Cannot restore ${table}(${rowId}): parent ${rel.to}(${parent.parentId}) is deleted or missing`);
      }

    for (const [table, rowId] of rows) {
      const hook = ctx.hooks[table]?.beforeRestore;
      if (hook && invokeHookSync(ctx, table, "beforeRestore", () => hook(rowId)) === false) {
        if (table === entityName && rowId === id) { rows.length = 0; return; }
        throw new Error(`Cascade cancelled: ${table}.beforeRestore(${rowId}) returned false`);
      }
    }
    for (const [table, rowId] of rows) {
      try {
        const result = ctx._stmt(
          `UPDATE ${qi(table)} SET "deletedAt" = NULL WHERE id = ? AND "deletedAt" = ?`,
        ).run(rowId, stamp);
        if (statementChanges(ctx) === 0) throw new Error(`Restore lost row ${table}(${rowId})`);
      } catch (e) {
        if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String(e)))
          throw new Error(`Cannot restore ${table}(${rowId}): unique constraint conflict`, { cause: e });
        throw e;
      }
    }
  });
  return rows.reverse();
}

/**
 * Bulk deletes are SQL writes, not per-entity lifecycle operations. Visit
 * configured descendants once, children first, and count only root rows.
 * This also prevents select().deleteAll() from reporting the final child's
 * changes() instead of the number of selected parent rows.
 */
export function deleteMatching(
  ctx: DatabaseContext,
  entityName: string,
  where: string,
  params: any[],
): number {
  if (ctx.viewNames.has(entityName))
    throw new Error(`Cannot delete from read-only view "${entityName}"`);
  return ctx._transaction(() => {
    const visible = ctx.softDeletes
      ? `${where ? `(${where}) AND ` : ""}"deletedAt" IS NULL`
      : (where || "1=1");
    const roots = ctx._stmt(`SELECT id FROM ${qi(entityName)} WHERE ${visible}`)
      .all(...params) as { id: number }[];
    const visited = new Set<string>();
    const selectedRoots = new Set(roots.map((row) => row.id));
    const stamp = ctx.softDeletes ? deletionTimestamp() : "";
    let count = 0;

    const visit = (table: string, id: number): void => {
      const key = `${table}:${id}`;
      if (visited.has(key)) return;
      visited.add(key);
      const live = ctx._stmt(
        `SELECT id FROM ${qi(table)} WHERE id = ?${ctx.softDeletes ? ' AND "deletedAt" IS NULL' : ""}`,
      ).get(id);
      if (!live) return;
      for (const child of ctx.cascade[table] ?? [])
        for (const rel of ctx.relationships.filter(
          (r) => r.type === "belongs-to" && r.from === child && r.to === table,
        )) {
          const rows = ctx._stmt(
            `SELECT id FROM ${qi(child)} WHERE ${qi(rel.foreignKey)} = ?${ctx.softDeletes ? ' AND "deletedAt" IS NULL' : ""}`,
          ).all(id) as { id: number }[];
          for (const row of rows) visit(child, row.id);
        }

      if (ctx.softDeletes)
        ctx._stmt(`UPDATE ${qi(table)} SET "deletedAt" = ? WHERE id = ? AND "deletedAt" IS NULL`).run(stamp, id);
      else
        ctx._stmt(`DELETE FROM ${qi(table)} WHERE id = ?`).run(id);
      if (table === entityName && selectedRoots.has(id))
        count += statementChanges(ctx);
    };
    for (const row of roots) visit(entityName, row.id);
    return count;
  });
}

/** Bulk SQL delete: deliberately bypasses per-row beforeDelete/afterDelete hooks. */
export function deleteWhere(
  ctx: DatabaseContext,
  entityName: string,
  conditions: Record<string, any>,
): number {
  const { clause, values } = ctx.buildWhereClause(conditions);
  if (!clause)
    throw new Error("delete().where() requires at least one condition");

  if ((ctx.cascade[entityName] ?? []).length)
    return deleteMatching(ctx, entityName, clause.slice("WHERE ".length), values);

  if (ctx.softDeletes) {
    // Soft delete: set deletedAt instead of removing rows
    const now = deletionTimestamp();
    const sql = `UPDATE ${qi(entityName)} SET "deletedAt" = ? ${clause} AND "deletedAt" IS NULL`;
    ctx._m(`SQL: ${sql.slice(0, 50)}`, () =>
      ctx._stmt(sql).run(now, ...values),
    );

    return statementChanges(ctx);
  }

  const sql = `DELETE FROM ${qi(entityName)} ${clause}`;
  ctx._m(`SQL: ${sql.slice(0, 50)}`, () =>
    ctx._stmt(sql).run(...values),
  );

  return statementChanges(ctx);
}

/** Create a fluent delete builder: db.table.delete().where({...}).exec() */
export function createDeleteBuilder(
  ctx: DatabaseContext,
  entityName: string,
): DeleteBuilder<any> {
  let _conditions: Record<string, any> = {};
  const builder: DeleteBuilder<any> = {
    where: (conditions) => {
      _conditions = { ..._conditions, ...conditions };
      return builder;
    },
    exec: () => deleteWhere(ctx, entityName, _conditions),
  };
  return builder;
}

/** Insert multiple rows in a single transaction for better performance. */
export function insertMany<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  rows: Omit<T, "id">[],
): AugmentedEntity<any>[] {
  if (rows.length === 0) return [];
  const schema = ctx.schemas[entityName]!;
  const zodSchema = asZodObject(schema).passthrough();
  const hooks = ctx.hooks[entityName];

  const txn = () => {
    const ids: number[] = [];
    for (let data of rows) {
      let inputData = { ...data } as Record<string, any>;

      // beforeInsert hook
      if (hooks?.beforeInsert) {
        const result = invokeHookSync(ctx, entityName, "beforeInsert", () =>
          hooks.beforeInsert!(inputData));
        if (result) inputData = result;
      }

      const validatedData = zodSchema.parse(inputData);
      const transformed = transformForStorage(validatedData, schema);

      if (ctx.timestamps) {
        const now = new Date().toISOString();
        transformed.createdAt = now;
        transformed.updatedAt = now;
      }

      const columns = Object.keys(transformed);
      const quotedCols = columns.map(qi);
      const sql =
        columns.length === 0
          ? `INSERT INTO ${qi(entityName)} DEFAULT VALUES`
          : `INSERT INTO ${qi(entityName)} (${quotedCols.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      const result = ctx._stmt(sql).run(...Object.values(transformed));
      ids.push(result.lastInsertRowid as number);
    }
    return ids;
  };

  // Acquire the write lock before running hooks or inserting any rows.
  const ids = ctx._transaction(txn);
  const entities = ids
    .map((id: number) => getById(ctx, entityName, id)!)
    .filter(Boolean);

  // afterInsert hooks
  if (hooks?.afterInsert) {
    for (const entity of entities)
      ctx._afterCommit(() =>
        invokeHookSync(ctx, entityName, "afterInsert", () => hooks.afterInsert!(entity)));
  }

  return entities;
}

/** Upsert multiple rows in a single transaction. */
export function upsertMany<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  rows: any[],
  conditions: Record<string, any> = {},
): AugmentedEntity<any>[] {
  if (rows.length === 0) return [];

  return ctx._transaction(() => {
    const results: AugmentedEntity<any>[] = [];
    for (const data of rows) {
      results.push(upsert(ctx, entityName, data, conditions));
    }
    return results;
  });
}

/**
 * Validate the fields of a partial update. Zod 4 fills in `.default()` values
 * for fields left out even under `.partial()`, which would overwrite stored
 * data, so only the fields the caller passed are kept.
 */
function parsePartial(schema: any, data: Record<string, any>): Record<string, any> {
  const parsed = asZodObject(schema).partial().parse(data) as Record<string, any>;
  const out: Record<string, any> = {};
  for (const key of Object.keys(parsed)) {
    if (Object.hasOwn(data, key)) out[key] = parsed[key];
  }
  return out;
}
