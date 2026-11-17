/**
 * sql-helpers.ts — SQL utility functions extracted from Database class.
 *
 * Contains WHERE clause building and other SQL-level helpers.
 */
import { transformForStorage } from "./schema";

/**
 * Build a parameterized WHERE clause from a conditions object.
 *
 * Supports:
 * - Simple equality: `{ name: 'Alice' }`
 * - Operators: `{ age: { $gt: 18 } }`
 * - $in: `{ status: { $in: ['active', 'pending'] } }`
 * - $or: `{ $or: [{ name: 'Alice' }, { name: 'Bob' }] }`
 * - $isNull / $isNotNull: `{ deletedAt: { $isNull: true } }`
 */
export function buildWhereClause(
  conditions: Record<string, any>,
  tablePrefix?: string,
): { clause: string; values: any[] } {
  const parts: string[] = [];
  const values: any[] = [];

  for (const key of Object.keys(conditions)) {
    if (key.startsWith("$")) {
      if (key === "$or" && Array.isArray(conditions[key])) {
        const orBranches = conditions[key] as Record<string, any>[];
        if (orBranches.length === 0) {
          parts.push("1 = 0");
          continue;
        }
        const orParts: string[] = [];
        for (const branch of orBranches) {
          if (!branch || typeof branch !== "object" || Array.isArray(branch) || Object.keys(branch).length === 0)
            throw new Error("$or requires non-empty object branches");
          const sub = buildWhereClause(branch, tablePrefix);
          if (sub.clause) {
            orParts.push(`(${sub.clause.replace(/^WHERE /, "")})`);
            values.push(...sub.values);
          }
        }
        if (orParts.length > 0) parts.push(`(${orParts.join(" OR ")})`);
      } else {
        throw new Error(`Unsupported query operator: '${key}'`);
      }
      continue;
    }
    const value = conditions[key];
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const fieldName = tablePrefix ? `${quote(tablePrefix)}.${quote(key)}` : quote(key);

    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const operators = Object.keys(value);
      if (!operators.length || operators.some((operator) => !operator.startsWith("$"))) {
        throw new Error(
          `Querying on nested object '${key}' not supported. Use operators like $gt.`,
        );
      }
      for (const operator of operators) {
      const operand = value[operator];

      if (operator === "$in") {
        if (!Array.isArray(operand))
          throw new Error(`$in for '${key}' requires an array`);
        if (operand.length === 0) {
          parts.push("1 = 0");
          continue;
        }
        parts.push(`${fieldName} IN (${operand.map(() => "?").join(", ")})`);
        values.push(...operand.map((v: any) => transformForStorage({ v }).v));
        continue;
      }

      if (operator === "$notIn") {
        if (!Array.isArray(operand))
          throw new Error(`$notIn for '${key}' requires an array`);
        if (operand.length === 0) continue; // no-op: everything is "not in" an empty set
        parts.push(
          `${fieldName} NOT IN (${operand.map(() => "?").join(", ")})`,
        );
        values.push(...operand.map((v: any) => transformForStorage({ v }).v));
        continue;
      }

      if (operator === "$like") {
        parts.push(`${fieldName} LIKE ?`);
        values.push(operand);
        continue;
      }

      if (operator === "$between") {
        if (!Array.isArray(operand) || operand.length !== 2)
          throw new Error(`$between for '${key}' requires [min, max]`);
        parts.push(`${fieldName} BETWEEN ? AND ?`);
        values.push(
          transformForStorage({ v: operand[0] }).v,
          transformForStorage({ v: operand[1] }).v,
        );
        continue;
      }

      if (operator === "$isNull") {
        parts.push(`${fieldName} IS NULL`);
        continue;
      }

      if (operator === "$isNotNull") {
        parts.push(`${fieldName} IS NOT NULL`);
        continue;
      }

      const sqlOp = (
        { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=", $ne: "!=" } as Record<
          string,
          string
        >
      )[operator];
      if (!sqlOp)
        throw new Error(`Unsupported operator '${operator}' on '${key}'`);
      if (operand === null && operator === "$ne") {
        parts.push(`${fieldName} IS NOT NULL`);
      } else {
        parts.push(`${fieldName} ${sqlOp} ?`);
        values.push(transformForStorage({ operand }).operand);
      }
      }
    } else {
      if (value === null) {
        parts.push(`${fieldName} IS NULL`);
      } else {
        parts.push(`${fieldName} = ?`);
        values.push(transformForStorage({ value }).value);
      }
    }
  }

  return {
    clause: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "",
    values,
  };
}
