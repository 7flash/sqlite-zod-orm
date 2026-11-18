/**
 * query.ts — Barrel re-export + QueryBuilder factory
 *
 * Previously contained all query logic (IQO, QueryBuilder, proxy system).
 * Now split into focused modules:
 *   - iqo.ts     — IQO types and compiler
 *   - builder.ts — QueryBuilder class
 *   - proxy.ts   — Proxy query system (ColumnNode, compileProxyQuery, etc.)
 *
 * This file re-exports everything for backwards compatibility and houses
 * the createQueryBuilder factory that wires executors to the database.
 */

import { transformFromStorage } from "./schema";
import type { DatabaseContext } from "./context";

// Re-export all public API from split modules
export { compileIQO, OPERATOR_MAP, transformValueForStorage } from "./iqo";
export type {
  IQO,
  WhereCondition,
  JoinClause,
  OrderDirection,
  WhereOperator,
} from "./iqo";

export { QueryBuilder } from "./builder";
export type { QueryCacheOptions } from "./builder";
import { QueryBuilder } from "./builder";
import { deleteMatching } from "./crud";

export {
  ColumnNode,
  createContextProxy,
  compileProxyQuery,
  executeProxyQuery,
} from "./proxy";
export type { ProxyQueryResult } from "./proxy";

// =============================================================================
// QueryBuilder Factory
// =============================================================================

// The SQL executor / join and relation resolvers depend on context and table,
// not on the per-call QueryBuilder's IQO. Reuse them across select() calls.
const queryFactories = new WeakMap<DatabaseContext, Map<string, (cols: string[]) => QueryBuilder<any>>>();

/**
 * Create a QueryBuilder instance wired to the database.
 *
 * Constructs all the closures (executor, joinResolver, conditionResolver,
 * revisionGetter, eagerLoader) that the QueryBuilder needs to execute
 * queries against the actual SQLite database.
 */
export function createQueryBuilder(
  ctx: DatabaseContext,
  entityName: string,
  initialCols: string[],
): QueryBuilder<any> {
  const cached = queryFactories.get(ctx)?.get(entityName);
  if (cached) return cached(initialCols);

  const schema = ctx.schemas[entityName]!;

  const executor = (sql: string, params: any[], raw: boolean): any[] => {
    // Batch updates have the same timestamp contract as update(id).
    const table = `"${entityName.replace(/"/g, '""')}"`;
    const prefix = `UPDATE ${table} SET `;
    if (ctx.timestamps && sql.startsWith(prefix)) {
      // Only inspect the SET clause: a WHERE predicate on updatedAt must not
      // suppress timestamp injection for an unrelated updated field.
      const setPart = sql.slice(prefix.length).split(/\s+WHERE\s+/i, 1)[0]!;
      if (!/"updatedAt"\s*=/.test(setPart)) {
        sql = sql.replace(prefix, `${prefix}"updatedAt" = ?, `);
        params = [new Date().toISOString(), ...params];
      }
    }
    // Keep debug timing around hydration, but avoid the timing wrapper,
    // interpolated label, and callback allocation when logging is disabled.
    if (!ctx.debug) {
      const rows = ctx._stmt(sql).all(...params);
      if (raw) return rows;
      return rows.map((row: any) =>
        ctx.attachMethods(entityName, transformFromStorage(row, schema)));
    }
    return ctx._m(`SQL: ${sql.slice(0, 60)}`, () => {
      const rows = ctx._stmt(sql).all(...params);
      if (raw) return rows;
      return rows.map((row: any) =>
        ctx.attachMethods(entityName, transformFromStorage(row, schema)));
    });
  };

  const singleExecutor = (
    sql: string,
    params: any[],
    raw: boolean,
  ): any | null => {
    // A point SELECT should not allocate an array of one row and invoke a
    // mapping callback. get() retains the same row shape and null semantics.
    if (!ctx.debug) {
      const row = ctx._stmt(sql).get(...params);
      if (!row) return null;
      return raw ? row : ctx.attachMethods(
        entityName, transformFromStorage(row as Record<string, any>, schema));
    }
    return ctx._m(`SQL: ${sql.slice(0, 60)}`, () => {
      const row = ctx._stmt(sql).get(...params);
      if (!row) return null;
      return raw ? row : ctx.attachMethods(
        entityName, transformFromStorage(row as Record<string, any>, schema));
    });
  };

  const joinResolver = (
    fromTable: string,
    toTable: string,
  ): { fk: string; pk: string } | null => {
    const candidates = ctx.relationships.filter(
      (r) => r.type === "belongs-to" && (
        (r.from === fromTable && r.to === toTable) ||
        (r.from === toTable && r.to === fromTable)
      ),
    );
    if (candidates.length > 1) {
      throw new Error(
        `Ambiguous automatic join between '${fromTable}' and '${toTable}': ` +
        `foreign keys ${candidates.map((r) => `${r.from}.${r.foreignKey}`).join(", ")}. ` +
        `Use join('${toTable}', fromColumn, columns, toColumn) to specify the join.`,
      );
    }
    const rel = candidates[0];
    if (!rel) return null;
    return rel.from === fromTable
      ? { fk: rel.foreignKey, pk: "id" }
      : { fk: "id", pk: rel.foreignKey };
  };

  const conditionResolver = (
    conditions: Record<string, any>,
  ): Record<string, any> => {
    const resolved: Record<string, any> = {};
    for (const [key, value] of Object.entries(conditions)) {
      if (
        value &&
        typeof value === "object" &&
        typeof value.id === "number" &&
        typeof value.delete === "function"
      ) {
        const candidates = ctx.relationships.filter(
          (r) => r.type === "belongs-to" && r.from === entityName,
        );
        const direct = candidates.filter(
          (r) => r.foreignKey === key || r.foreignKey === key + "_id" ||
            r.relationshipField === key,
        );
        const matches = direct.length ? direct : candidates.filter(
          (r) => r.to === key || r.to === key + "s",
        );
        if (matches.length > 1)
          throw new Error(
            `Ambiguous relationship '${key}' on '${entityName}': ` +
            `${matches.map((r) => r.foreignKey).join(", ")}. Use the FK or navigation name.`,
          );
        if (matches[0]) resolved[matches[0].foreignKey] = value.id;
        else resolved[key] = value;
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  };

  // SQLite builds can still use the older 999-host-parameter limit.
  const MAX_RELATION_IDS = 900;
  const eagerLoader = (
    parentTable: string,
    relation: string,
    parentIds: number[],
    sourceRows?: any[],
  ): { key: string; table: string; groups: Map<number, any>; many: boolean } | null => {
    const hasMany = ctx.relationships.find(
      (r) =>
        r.type === "one-to-many" &&
        r.from === parentTable &&
        r.relationshipField === relation,
    );
    if (hasMany) {
      const fk = hasMany.foreignKey;
      const groups = new Map<number, any[]>();
      const childSchema = ctx.schemas[hasMany.to]!;
      const table = `"${hasMany.to.replace(/"/g, '""')}"`;
      const column = `"${fk.replace(/"/g, '""')}"`;
      const visible = ctx.softDeletes && !ctx.viewNames.has(hasMany.to)
        ? ' AND "deletedAt" IS NULL' : '';
      for (let start = 0; start < parentIds.length; start += MAX_RELATION_IDS) {
        const batch = parentIds.slice(start, start + MAX_RELATION_IDS);
        const placeholders = batch.map(() => "?").join(", ");
        const childRows = ctx._stmt(
          `SELECT * FROM ${table} WHERE ${column} IN (${placeholders})${visible} ORDER BY "id"`,
        ).all(...batch) as any[];
        for (const rawRow of childRows) {
          const entity = ctx.attachMethods(
            hasMany.to,
            transformFromStorage(rawRow, childSchema),
          );
          const parentId = rawRow[fk] as number;
          if (!groups.has(parentId)) groups.set(parentId, []);
          groups.get(parentId)!.push(entity);
        }
      }
      return { key: relation, table: hasMany.to, groups, many: true };
    }

    const belongsTo = ctx.relationships.find(
      (r) =>
        r.type === "belongs-to" &&
        r.from === parentTable &&
        r.relationshipField === relation,
    );
    if (belongsTo) {
      const fk = belongsTo.foreignKey;
      // Full rows (including already eager-loaded children) already carry
      // the FK. Retain the original lookup for projections without the FK.
      let parentRows: any[];
      if (sourceRows && sourceRows.every(row => {
        const descriptor = Object.getOwnPropertyDescriptor(row, fk);
        return typeof row.id === "number" && descriptor && "value" in descriptor;
      })) {
        // Read the original field, not a possibly overriding computed getter.
        parentRows = sourceRows.map(row => ({
          id: row.id,
          [fk]: Object.getOwnPropertyDescriptor(row, fk)!.value,
        }));
      } else {
        parentRows = [];
        const table = `"${parentTable.replace(/"/g, '""')}"`;
        const column = `"${fk.replace(/"/g, '""')}"`;
        for (let start = 0; start < parentIds.length; start += MAX_RELATION_IDS) {
          const batch = parentIds.slice(start, start + MAX_RELATION_IDS);
          const placeholders = batch.map(() => "?").join(", ");
          parentRows.push(...ctx._stmt(
            `SELECT "id", ${column} FROM ${table} WHERE "id" IN (${placeholders})`,
          ).all(...batch) as any[]);
        }
      }
      const targetIds = [...new Set(parentRows.map((r) => r[fk])
        .filter((id) => typeof id === "number"))];
      const groups = new Map<number, any>();
      if (targetIds.length > 0) {
        const table = `"${belongsTo.to.replace(/"/g, '""')}"`;
        const visible = ctx.softDeletes && !ctx.viewNames.has(belongsTo.to)
          ? ' AND "deletedAt" IS NULL' : '';
        const schema = ctx.schemas[belongsTo.to]!;
        const byId = new Map<number, any>();
        for (let start = 0; start < targetIds.length; start += MAX_RELATION_IDS) {
          const batch = targetIds.slice(start, start + MAX_RELATION_IDS);
          const placeholders = batch.map(() => "?").join(", ");
          const targetRows = ctx._stmt(
            `SELECT * FROM ${table} WHERE "id" IN (${placeholders})${visible}`,
          ).all(...batch) as any[];
          for (const row of targetRows)
            byId.set(row.id, ctx.attachMethods(belongsTo.to, transformFromStorage(row, schema)));
        }
        for (const row of parentRows) groups.set(row.id, byId.get(row[fk]) ?? null);
      }
      return { key: relation, table: belongsTo.to, groups, many: false };
    }

    return null;
  };

  const deleteExecutor = (where: string, params: any[]) =>
    deleteMatching(ctx, entityName, where, params);
  const liveJoinTables = ctx.softDeletes
    ? Object.keys(ctx.schemas).filter((name) => !ctx.viewNames.has(name)) : [];
  const factory = (cols: string[]): QueryBuilder<any> => {
    const builder = new QueryBuilder(
      entityName,
      executor,
      singleExecutor,
      joinResolver,
      conditionResolver,
      eagerLoader,
    );
    // Internal batch mutation delegate (not an additional public method).
    (builder as any).deleteExecutor = deleteExecutor;
    // Each builder keeps its own IQO/array. Share the precomputed table list,
    // not the mutable array itself (including withTrashed/clone paths).
    (builder as any).iqo.softDeleteTables = liveJoinTables.slice();
    if (cols.length > 0) builder.select(...cols);
  
    // Auto-filter soft-deleted rows unless withTrashed() is called
    if (ctx.softDeletes && !ctx.viewNames.has(entityName)) {
      builder.where({ deletedAt: { $isNull: true } });
    }
  
    return builder;
  };
  let byTable = queryFactories.get(ctx);
  if (!byTable) queryFactories.set(ctx, byTable = new Map());
  byTable.set(entityName, factory);
  return factory(initialCols);
}
