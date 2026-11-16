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
  ): { key: string; groups: Map<number, any[]> } | null => {
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
        ._stmt(`SELECT * FROM "${hasMany.to.replace(/"/g, '""')}" WHERE "${fk.replace(/"/g, '""')}" IN (${placeholders})`)
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
      return { key: relation, groups };
    }

    const belongsTo = ctx.relationships.find(
      (r) =>
        r.type === "belongs-to" &&
        r.from === parentTable &&
        r.relationshipField === relation,
    );
    if (belongsTo) {
      return null;
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
  if (initialCols.length > 0) builder.select(...initialCols);

  // Auto-filter soft-deleted rows unless withTrashed() is called
  if (ctx.softDeletes && !ctx.viewNames.has(entityName)) {
    builder.where({ deletedAt: { $isNull: true } });
  }

  return builder;
}
