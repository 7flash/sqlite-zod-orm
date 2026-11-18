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
    return ctx._m(`SQL: ${sql.slice(0, 60)}`, () => {
      const rows = ctx._stmt(sql).all(...params);
      if (raw) return rows;
      return rows.map((row: any) =>
        ctx.attachMethods(entityName, transformFromStorage(row, schema)),
      );
    });
  };

  const singleExecutor = (
    sql: string,
    params: any[],
    raw: boolean,
  ): any | null => {
    const results = executor(sql, params, raw);
    return results.length > 0 ? results[0] : null;
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

  const eagerLoader = (
    parentTable: string,
    relation: string,
    parentIds: number[],
  ): { key: string; table: string; groups: Map<number, any>; many: boolean } | null => {
    const hasMany = ctx.relationships.find(
      (r) =>
        r.type === "one-to-many" &&
        r.from === parentTable &&
        r.relationshipField === relation,
    );
    if (hasMany) {
      const fk = hasMany.foreignKey;
      const placeholders = parentIds.map(() => "?").join(", ");
      const childRows = ctx
        ._stmt(`SELECT * FROM "${hasMany.to.replace(/"/g, '""')}" WHERE "${fk.replace(/"/g, '""')}" IN (${placeholders})${ctx.softDeletes && !ctx.viewNames.has(hasMany.to) ? ' AND "deletedAt" IS NULL' : ''} ORDER BY "id"`)
        .all(...parentIds) as any[];

      const groups = new Map<number, any[]>();
      const childSchema = ctx.schemas[hasMany.to]!;
      for (const rawRow of childRows) {
        const entity = ctx.attachMethods(
          hasMany.to,
          transformFromStorage(rawRow, childSchema),
        );
        const parentId = rawRow[fk] as number;
        if (!groups.has(parentId)) groups.set(parentId, []);
        groups.get(parentId)!.push(entity);
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
      // Only the requested parents are inspected; no unrelated parent can
      // leak into a group when two FKs reference the same target table.
      const placeholders = parentIds.map(() => "?").join(", ");
      const parentRows = ctx._stmt(
        `SELECT "id", "${fk.replace(/"/g, '""')}" FROM "${parentTable.replace(/"/g, '""')}" WHERE "id" IN (${placeholders})`,
      ).all(...parentIds) as any[];
      const targetIds = [...new Set(parentRows.map((r) => r[fk]).filter((id) => typeof id === "number"))];
      const groups = new Map<number, any>();
      if (targetIds.length > 0) {
        const targetPlaceholders = targetIds.map(() => "?").join(", ");
        const targetRows = ctx._stmt(
          `SELECT * FROM "${belongsTo.to.replace(/"/g, '""')}" WHERE "id" IN (${targetPlaceholders})${ctx.softDeletes && !ctx.viewNames.has(belongsTo.to) ? ' AND "deletedAt" IS NULL' : ''}`,
        ).all(...targetIds) as any[];
        const schema = ctx.schemas[belongsTo.to]!;
        const byId = new Map<number, any>();
        for (const row of targetRows)
          byId.set(row.id, ctx.attachMethods(belongsTo.to, transformFromStorage(row, schema)));
        for (const row of parentRows) groups.set(row.id, byId.get(row[fk]) ?? null);
      }
      return { key: relation, table: belongsTo.to, groups, many: false };
    }

    return null;
  };

  const builder = new QueryBuilder(
    entityName,
    executor,
    singleExecutor,
    joinResolver,
    conditionResolver,
    eagerLoader,
  );
  // Internal batch mutation delegate (not an additional public method).
  (builder as any).deleteExecutor = (where: string, params: any[]) =>
    deleteMatching(ctx, entityName, where, params);
  // Join targets, including explicit joins, must also be live tables.
  (builder as any).iqo.softDeleteTables = ctx.softDeletes
    ? Object.keys(ctx.schemas).filter((name) => !ctx.viewNames.has(name)) : [];
  if (initialCols.length > 0) builder.select(...initialCols);

  // Auto-filter soft-deleted rows unless withTrashed() is called
  if (ctx.softDeletes && !ctx.viewNames.has(entityName)) {
    builder.where({ deletedAt: { $isNull: true } });
  }

  return builder;
}
