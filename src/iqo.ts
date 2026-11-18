/**
 * iqo.ts — Internal Query Object types and SQL compiler
 *
 * Defines the IQO structure, WHERE operators, and the `compileIQO` function
 * that transforms an IQO into executable SQL + params.
 */

import { type ASTNode, compileAST } from "./ast";

// =============================================================================
// IQO — Internal Query Object
// =============================================================================

export type OrderDirection = "asc" | "desc";
export type WhereOperator =
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$ne"
  | "$in"
  | "$like"
  | "$notIn"
  | "$between"
  | "$isNull"
  | "$isNotNull";

export interface WhereCondition {
  field: string;
  operator:
    | "="
    | ">"
    | ">="
    | "<"
    | "<="
    | "!="
    | "IN"
    | "LIKE"
    | "NOT IN"
    | "BETWEEN"
    | "IS NULL"
    | "IS NOT NULL";
  value: any;
}

export interface JoinClause {
  table: string;
  fromCol: string;
  toCol: string;
  columns: string[]; // columns to SELECT from the joined table
}

export interface IQO {
  selects: string[];
  wheres: WhereCondition[];
  whereOrs: WhereCondition[][]; // Legacy flat OR groups (preserved for external IQO callers)
  whereOrBranches?: WhereCondition[][][]; // OR-of-AND groups for object-style $or
  rawWheres: { sql: string; params: any[] }[]; // Raw WHERE fragments
  whereAST: ASTNode | null;
  joins: JoinClause[];
  softDeleteTables?: string[];
  groupBy: string[];
  having: WhereCondition[];
  limit: number | null;
  offset: number | null;
  orderBy: { field: string; direction: OrderDirection }[];
  includes: string[];
  raw: boolean;
  distinct: boolean;
}

export const OPERATOR_MAP: Record<WhereOperator, string> = {
  $gt: ">",
  $gte: ">=",
  $lt: "<",
  $lte: "<=",
  $ne: "!=",
  $in: "IN",
  $like: "LIKE",
  $notIn: "NOT IN",
  $between: "BETWEEN",
  $isNull: "IS NULL",
  $isNotNull: "IS NOT NULL",
};

// Quote dotted identifier paths (e.g. table.column), never SQL expressions.
// Identifier paths are generally schema/field constants, even when bound
// values change on every query. Cache only validated paths and cap retention
// for callers that generate arbitrary identifiers.
const quotedIdentifierCache = new Map<string, string>();
export function quoteIdentifierPath(field: string): string {
  if (typeof field !== "string" || field.length === 0)
    throw new Error("WHERE field must be a non-empty identifier");
  const cached = quotedIdentifierCache.get(field);
  if (cached !== undefined) return cached;
  const parts = field.split(".");
  if (parts.some((part) => part.length === 0))
    throw new Error("Invalid qualified identifier");
  const quoted = parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
  if (quotedIdentifierCache.size >= 1024)
    quotedIdentifierCache.delete(quotedIdentifierCache.keys().next().value!);
  quotedIdentifierCache.set(field, quoted);
  return quoted;
}

const MAX_SQL_PARAMS = 32766;

/** LIMIT/OFFSET are written as text, so they must be plain non-negative integers. */
function sqlCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return value;
}

function sqlDirection(direction: unknown): "ASC" | "DESC" {
  const d = typeof direction === "string" ? direction.toUpperCase() : "";
  if (d !== "ASC" && d !== "DESC")
    throw new Error(`ORDER BY direction must be "asc" or "desc", got ${JSON.stringify(direction)}`);
  return d;
}

const HAVING_OPERATORS = new Set(["=", "!=", ">", ">=", "<", "<=", "IS NULL", "IS NOT NULL"]);
const SCALAR_OPERATORS = new Set(["=", ">", ">=", "<", "<=", "!=", "LIKE"]);

function compileWhereCondition(
  w: WhereCondition,
  field: string,
  params: any[],
): string | null {
  if (w.operator === "IN" || w.operator === "NOT IN") {
    if (!Array.isArray(w.value))
      throw new Error(`${w.operator} requires an array`);
    if (w.value.length > MAX_SQL_PARAMS)
      throw new Error(`IN list exceeds ${MAX_SQL_PARAMS} values`);
    if (w.value.length === 0) return w.operator === "IN" ? "1 = 0" : null;
    params.push(...w.value.map(transformValueForStorage));
    return `${field} ${w.operator} (${w.value.map(() => "?").join(", ")})`;
  }
  if (w.operator === "BETWEEN") {
    if (!Array.isArray(w.value) || w.value.length !== 2)
      throw new Error("BETWEEN requires exactly two values");
    params.push(...w.value.map(transformValueForStorage));
    return `${field} BETWEEN ? AND ?`;
  }
  if (w.operator === "IS NULL" || w.operator === "IS NOT NULL")
    return `${field} ${w.operator}`;
  if (!SCALAR_OPERATORS.has(w.operator))
    throw new Error(`Unsupported SQL WHERE operator: ${w.operator}`);
  if (w.value === null && (w.operator === "=" || w.operator === "!="))
    return `${field} IS ${w.operator === "!=" ? "NOT " : ""}NULL`;
  params.push(transformValueForStorage(w.value));
  return `${field} ${w.operator} ?`;
}

export function transformValueForStorage(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array))
    return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);
  return value;
}

/**
 * Compile an Internal Query Object into executable SQL + params.
 * Handles SELECT, JOIN, WHERE (object + AST + $or), ORDER BY, LIMIT, OFFSET.
 */
export function compileIQO(
  tableName: string,
  iqo: IQO,
): { sql: string; params: any[] } {
  const params: any[] = [];

  // SELECT clause
  const selectParts: string[] = [];
  if (iqo.selects.length > 0) {
    selectParts.push(...iqo.selects.map((s) => `${quoteIdentifierPath(tableName)}.${quoteIdentifierPath(s)}`));
  } else {
    selectParts.push(`${quoteIdentifierPath(tableName)}.*`);
  }
  for (const j of iqo.joins) {
    if (j.columns.length > 0) {
      selectParts.push(
        ...j.columns.map(
          (c) =>
            `${quoteIdentifierPath(j.table)}.${quoteIdentifierPath(c)} AS ${quoteIdentifierPath(`${j.table}_${c}`)}`,
        ),
      );
    } else {
      selectParts.push(`${quoteIdentifierPath(j.table)}.*`);
    }
  }

  let sql = `SELECT ${iqo.distinct ? "DISTINCT " : ""}${selectParts.join(", ")} FROM ${quoteIdentifierPath(tableName)}`;

  // JOIN clauses
  for (const j of iqo.joins) {
    sql += ` JOIN ${quoteIdentifierPath(j.table)} ON ${quoteIdentifierPath(tableName)}.${quoteIdentifierPath(j.fromCol)} = ${quoteIdentifierPath(j.table)}.${quoteIdentifierPath(j.toCol)}`;
    if (iqo.softDeleteTables?.includes(j.table))
      sql += ` AND ${quoteIdentifierPath(j.table)}."deletedAt" IS NULL`;
  }

  // AST and object filters are both mandatory (including the visibility scope).
  if (iqo.whereAST) {
    // AST compiler validates and quotes its own identifiers/operators.
    const compiled = compileAST(iqo.whereAST);
    sql += ` WHERE ${compiled.sql}`;
    params.push(...compiled.params);
  }
  if (iqo.wheres.length > 0) {
    const hasJoins = iqo.joins.length > 0;
    const qualify = (field: string) =>
      hasJoins && !field.includes(".") ? `${tableName}.${field}` : field;
    const whereParts: string[] = [];
    for (const w of iqo.wheres) {
      const part = compileWhereCondition(
        w, quoteIdentifierPath(qualify(w.field)), params,
      );
      if (part) whereParts.push(part);
    }
    if (whereParts.length > 0) {
      sql += `${sql.includes(" WHERE ") ? " AND " : " WHERE "}${whereParts.join(" AND ")}`;
    }
  }

  // Legacy IQO OR groups remain supported for callers constructing IQO directly.
  if (iqo.whereOrs.length > 0) {
    const hasJoins = iqo.joins.length > 0;
    for (const orGroup of iqo.whereOrs) {
      const orParts: string[] = [];
      for (const w of orGroup) {
        const field = hasJoins && !w.field.includes(".")
          ? `${tableName}.${w.field}` : w.field;
        const part = compileWhereCondition(w, quoteIdentifierPath(field), params);
        if (part) orParts.push(part);
      }
      if (orParts.length > 0) {
        sql += `${sql.includes(" WHERE ") ? " AND " : " WHERE "}(${orParts.join(" OR ")})`;
      }
    }
  }

  // Preserve AND within each branch of fluent object-style $or.
  for (const orGroup of iqo.whereOrBranches ?? []) {
    const orParts: string[] = [];
    for (const branch of orGroup) {
      const andParts: string[] = [];
      for (const w of branch) {
        const field = iqo.joins.length > 0 && !w.field.includes(".")
          ? `${tableName}.${w.field}` : w.field;
        const part = compileWhereCondition(w, quoteIdentifierPath(field), params);
        if (part) andParts.push(part);
      }
      orParts.push(andParts.length ? `(${andParts.join(" AND ")})` : "(1 = 1)");
    }
    if (orParts.length > 0) {
      sql += `${sql.includes(" WHERE ") ? " AND " : " WHERE "}(${orParts.join(" OR ")})`;
    }
  }

  // Append raw WHERE fragments
  if (iqo.rawWheres && iqo.rawWheres.length > 0) {
    for (const rw of iqo.rawWheres) {
      sql += sql.includes(" WHERE ")
        ? ` AND (${rw.sql})`
        : ` WHERE (${rw.sql})`;
      params.push(...rw.params);
    }
  }

  // GROUP BY
  if (iqo.groupBy.length > 0) {
    sql += ` GROUP BY ${iqo.groupBy.map(quoteIdentifierPath).join(", ")}`;
  }

  // HAVING
  if (iqo.having && iqo.having.length > 0) {
    const havingParts: string[] = [];
    for (const h of iqo.having) {
      if (!HAVING_OPERATORS.has(h.operator))
        throw new Error(`Unsupported HAVING operator: ${String(h.operator)}`);
      if (h.operator === "IS NULL") {
        havingParts.push(`${h.field} IS NULL`);
      } else if (h.operator === "IS NOT NULL") {
        havingParts.push(`${h.field} IS NOT NULL`);
      } else {
        havingParts.push(`${h.field} ${h.operator} ?`);
        params.push(transformValueForStorage(h.value));
      }
    }
    if (havingParts.length > 0) {
      sql += ` HAVING ${havingParts.join(" AND ")}`;
    }
  }

  // ORDER BY
  if (iqo.orderBy.length > 0) {
    const parts = iqo.orderBy.map(
      (o) => `${quoteIdentifierPath(iqo.joins.length > 0 && !o.field.includes(".") ? `${tableName}.${o.field}` : o.field)} ${sqlDirection(o.direction)}`,
    );
    sql += ` ORDER BY ${parts.join(", ")}`;
  }

  if (iqo.limit !== null) sql += ` LIMIT ${sqlCount(iqo.limit, "limit")}`;
  if (iqo.offset !== null) {
    if (iqo.limit === null) sql += " LIMIT -1";
    sql += ` OFFSET ${sqlCount(iqo.offset, "offset")}`;
  }

  if (params.length > MAX_SQL_PARAMS)
    throw new Error(`Query exceeds ${MAX_SQL_PARAMS} bound parameters`);
  return { sql, params };
}
