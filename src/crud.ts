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

const activeHooks = new WeakMap<object, Set<string>>();

/** Lifecycle hooks are synchronous. Reject promises and same-hook re-entry. */
function invokeHookSync<T>(
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
  const transformed = transformForStorage(validatedData);

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
    invokeHookSync(ctx, entityName, "afterInsert", () =>
      hooks.afterInsert!(newEntity));

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
): AugmentedEntity<any> | null {
  const schema = ctx.schemas[entityName]!;
  let inputData = { ...data } as Record<string, any>;

  // beforeUpdate hook — can transform data
  const hooks = ctx.hooks[entityName];
  if (hooks?.beforeUpdate) {
    const result = invokeHookSync(
      ctx, entityName, "beforeUpdate", () => hooks.beforeUpdate!(inputData, id),
    );
    if (result) inputData = result;
  }

  const validatedData = asZodObject(schema).partial().parse(inputData);
  const transformed = transformForStorage(validatedData);
  if (Object.keys(transformed).length === 0 && !ctx.timestamps)
    return getById(ctx, entityName, id);

  // Auto-update timestamp
  if (ctx.timestamps) {
    transformed.updatedAt = new Date().toISOString();
  }

  const setClause = Object.keys(transformed)
    .map((key) => `${qi(key)} = ?`)
    .join(", ");
  const sql = `UPDATE ${qi(entityName)} SET ${setClause} ${visibleWhere(ctx, entityName, "WHERE id = ?")}`;
  ctx._m(`SQL: UPDATE ${entityName} SET ...`, () => {
    ctx._stmt(sql).run(...Object.values(transformed), id);
  });

  const updated = getById(ctx, entityName, id);

  // afterUpdate hook
  if (!deferAfterHook && hooks?.afterUpdate && updated)
    invokeHookSync(ctx, entityName, "afterUpdate", () =>
      hooks.afterUpdate!(updated));

  return updated;
}

/** Bulk SQL update: deliberately bypasses per-row beforeUpdate/afterUpdate hooks. */
export function updateWhere(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
  conditions: Record<string, any>,
): number {
  const schema = ctx.schemas[entityName]!;
  const validatedData = asZodObject(schema).partial().parse(data);
  const transformed = transformForStorage(validatedData);
  if (Object.keys(transformed).length === 0) return 0;

  const { clause, values: whereValues } = ctx.buildWhereClause(conditions);
  if (!clause)
    throw new Error("update().where() requires at least one condition");

  const setCols = Object.keys(transformed);
  const setClause = setCols.map((key) => `${qi(key)} = ?`).join(", ");
  const result = ctx
    ._stmt(`UPDATE ${qi(entityName)} SET ${setClause} ${visibleWhere(ctx, entityName, clause)}`)
    .run(...setCols.map((key) => transformed[key]), ...whereValues);

  return (result as any).changes ?? 0;
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
  const txn = ctx.db.transaction(() => {
    const hasId = data?.id && typeof data.id === "number";
    const existing = hasId
      ? getById(ctx, entityName, data.id, true)
      : Object.keys(conditions ?? {}).length > 0
        ? getOne(ctx, entityName, conditions, true)
        : null;

    if (existing) {
      // Reuse the unique key rather than inserting into a retained unique index.
      if (ctx.softDeletes && existing.deletedAt != null)
        ctx._stmt(`UPDATE ${qi(entityName)} SET "deletedAt" = NULL WHERE id = ?`).run(existing.id);
      const updateData = { ...data };
      delete updateData.id;
      const entity = update(
        ctx,
        entityName,
        existing.id,
        updateData,
        true,
      );
      if (!entity) throw new Error("Failed to retrieve entity after upsert");
      return { entity, created: false };
    }

    const insertData = { ...(conditions ?? {}), ...(data ?? {}) };
    delete insertData.id;
    return {
      entity: executeInsert(ctx, entityName, insertData, true),
      created: true,
    };
  });

  const result = txn.immediate();

  // After-hooks must describe committed changes, never rolled-back ones.
  const hooks = ctx.hooks[entityName];
  if (result.created && hooks?.afterInsert)
    invokeHookSync(ctx, entityName, "afterInsert", () =>
      hooks.afterInsert!(result.entity));
  else if (!result.created && hooks?.afterUpdate)
    invokeHookSync(ctx, entityName, "afterUpdate", () =>
      hooks.afterUpdate!(result.entity));

  return result.entity;
}

/** Find a row matching conditions, or create it with the merged data. Returns { entity, created }. */
export function findOrCreate<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  conditions: Record<string, any>,
  defaults: Record<string, any> = {},
): { entity: AugmentedEntity<any>; created: boolean } {
  const existing = getOne(ctx, entityName, conditions);
  if (existing) return { entity: existing, created: false };
  const data = { ...conditions, ...defaults };
  delete (data as any).id;
  return { entity: executeInsert(ctx, entityName, data), created: true };
}

export function deleteEntity(
  ctx: DatabaseContext,
  entityName: string,
  id: number,
): void {
  // beforeDelete hook — return false to cancel
  const hooks = ctx.hooks[entityName];
  if (hooks?.beforeDelete) {
    const result = invokeHookSync(
      ctx, entityName, "beforeDelete", () => hooks.beforeDelete!(id),
    );
    if (result === false) return;
  }

  const changed = ctx.db.transaction(() => {
    if (!getById(ctx, entityName, id)) return false;
    const now = new Date().toISOString();
    for (const child of ctx.cascade[entityName] ?? []) {
      const rel = ctx.relationships.find(
        (r) => r.type === "belongs-to" && r.from === child && r.to === entityName,
      );
      if (!rel) continue;
      if (ctx.softDeletes)
        ctx._stmt(`UPDATE ${qi(child)} SET "deletedAt" = ? WHERE ${qi(rel.foreignKey)} = ? AND "deletedAt" IS NULL`).run(now, id);
      else
        ctx._stmt(`DELETE FROM ${qi(child)} WHERE ${qi(rel.foreignKey)} = ?`).run(id);
    }
    const result = ctx.softDeletes
      ? ctx._stmt(`UPDATE ${qi(entityName)} SET "deletedAt" = ? WHERE id = ? AND "deletedAt" IS NULL`).run(now, id)
      : ctx._stmt(`DELETE FROM ${qi(entityName)} WHERE id = ?`).run(id);
    return result.changes > 0;
  }).immediate();

  // afterDelete hook
  if (changed && hooks?.afterDelete)
    invokeHookSync(ctx, entityName, "afterDelete", () =>
      hooks.afterDelete!(id));
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

  if (ctx.softDeletes) {
    // Soft delete: set deletedAt instead of removing rows
    const now = new Date().toISOString();
    const sql = `UPDATE ${qi(entityName)} SET "deletedAt" = ? ${clause} AND "deletedAt" IS NULL`;
    const result = ctx._m(`SQL: ${sql.slice(0, 50)}`, () =>
      ctx._stmt(sql).run(now, ...values),
    );
    return (result as any).changes ?? 0;
  }

  const sql = `DELETE FROM ${qi(entityName)} ${clause}`;
  const result = ctx._m(`SQL: ${sql.slice(0, 50)}`, () =>
    ctx._stmt(sql).run(...values),
  );
  return (result as any).changes ?? 0;
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

  const txn = ctx.db.transaction(() => {
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
      const transformed = transformForStorage(validatedData);

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
  });

  // Acquire the write lock before running hooks or inserting any rows.
  const ids = txn.immediate();
  const entities = ids
    .map((id: number) => getById(ctx, entityName, id)!)
    .filter(Boolean);

  // afterInsert hooks
  if (hooks?.afterInsert) {
    for (const entity of entities)
      invokeHookSync(ctx, entityName, "afterInsert", () => hooks.afterInsert!(entity));
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

  const txn = ctx.db.transaction(() => {
    const results: AugmentedEntity<any>[] = [];
    for (const data of rows) {
      results.push(upsert(ctx, entityName, data, conditions));
    }
    return results;
  });

  return txn.immediate();
}
