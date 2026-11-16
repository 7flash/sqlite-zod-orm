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
  whereOrs: WhereCondition[][]; // Each sub-array is an OR group
  rawWheres: { sql: string; params: any[] }[]; // Raw WHERE fragments
  whereAST: ASTNode | null;
  joins: JoinClause[];
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
export function quoteIdentifierPath(field: string): string {
  if (typeof field !== "string" || field.length === 0)
    throw new Error("WHERE field must be a non-empty identifier");
  const parts = field.split(".");
  if (parts.some((part) => part.length === 0))
    throw new Error("Invalid qualified identifier");
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

const MAX_SQL_PARAMS = 32766;
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
  params.push(transformValueForStorage(w.value));
  return `${field} ${w.operator} ?`;
}

export function transformValueForStorage(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
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
    selectParts.push(...iqo.selects.map((s) => `${tableName}.${s}`));
  } else {
    selectParts.push(`${tableName}.*`);
  }
  for (const j of iqo.joins) {
    if (j.columns.length > 0) {
      selectParts.push(
        ...j.columns.map((c) => `${j.table}.${c} AS ${j.table}_${c}`),
      );
    } else {
      selectParts.push(`${j.table}.*`);
    }
  }

  let sql = `SELECT ${iqo.distinct ? "DISTINCT " : ""}${selectParts.join(", ")} FROM ${tableName}`;

  // JOIN clauses
  for (const j of iqo.joins) {
    sql += ` JOIN ${j.table} ON ${tableName}.${j.fromCol} = ${j.table}.${j.toCol}`;
  }

  // WHERE clause — AST-based takes precedence if set
  if (iqo.whereAST) {
    // AST compiler validates and quotes its own identifiers/operators.
    const compiled = compileAST(iqo.whereAST);
    sql += ` WHERE ${compiled.sql}`;
    params.push(...compiled.params);
  } else if (iqo.wheres.length > 0) {
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
      sql += ` WHERE ${whereParts.join(" AND ")}`;
    }
  }

  // Append OR groups (from $or)
  if (iqo.whereOrs.length > 0) {
    const hasJoins = iqo.joins.length > 0;
    for (const orGroup of iqo.whereOrs) {
      const orParts: string[] = [];
      for (const w of orGroup) {
        const field = hasJoins && !w.field.includes(".")
          ? `${tableName}.${w.field}` : w.field;
        const part = compileWhereCondition(
          w, quoteIdentifierPath(field), params,
        );
        if (part) orParts.push(part);
      }
      if (orParts.length > 0) {
        const orClause = `(${orParts.join(" OR ")})`;
        sql += sql.includes(" WHERE ")
          ? ` AND ${orClause}`
          : ` WHERE ${orClause}`;
      }
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
    sql += ` GROUP BY ${iqo.groupBy.join(", ")}`;
  }

  // HAVING
  if (iqo.having && iqo.having.length > 0) {
    const havingParts: string[] = [];
    for (const h of iqo.having) {
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
      (o) => `${o.field} ${o.direction.toUpperCase()}`,
    );
    sql += ` ORDER BY ${parts.join(", ")}`;
  }

  if (iqo.limit !== null) sql += ` LIMIT ${iqo.limit}`;
  if (iqo.offset !== null) sql += ` OFFSET ${iqo.offset}`;

  if (params.length > MAX_SQL_PARAMS)
    throw new Error(`Query exceeds ${MAX_SQL_PARAMS} bound parameters`);
  return { sql, params };
}
