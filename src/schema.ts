/**
 * schema.ts — Schema parsing, relationship detection, and DDL helpers
 */
import { z } from "zod";
import type { SchemaMap, ZodType, Relationship } from "./types";
import { asZodObject } from "./types";

/**
 * Parse declarative `relations` config into Relationship[] objects.
 *
 * Config format: `{ childTable: { fkColumn: 'parentTable' } }`
 * Example: `{ books: { author_id: 'authors' } }` produces:
 *   - books → authors  (belongs-to, FK = author_id, nav = author)
 *   - authors → books  (one-to-many, nav = books)
 */
export function parseRelationsConfig(
  relations: Record<string, Record<string, string>>,
  schemas: SchemaMap,
): Relationship[] {
  const relationships: Relationship[] = [];
  const added = new Set<string>();
  const navigationNames = new Set<string>();
  // Generated columns must never be replaced by lazy accessors. Reserve them
  // independently of whether the corresponding option is currently enabled.
  const reserved = new Set([
    "id", "update", "delete", "createdAt", "updatedAt", "deletedAt",
  ]);
  const navigationName = (table: string, base: string) => {
    const shape = asZodObject(schemas[table]!).shape;
    let name = base;
    while (Object.prototype.hasOwnProperty.call(shape, name) || reserved.has(name)) {
      name += "Relation";
    }
    const key = `${table}.${name}`;
    if (navigationNames.has(key)) {
      throw new Error(`relations: conflicting navigation accessor '${key}'`);
    }
    navigationNames.add(key);
    return name;
  };

  for (const [fromTable, rels] of Object.entries(relations)) {
    if (!schemas[fromTable]) {
      throw new Error(`relations: unknown table '${fromTable}'`);
    }
    for (const [fkColumn, toTable] of Object.entries(rels)) {
      if (!schemas[toTable]) {
        throw new Error(
          `relations: unknown target table '${toTable}' in ${fromTable}.${fkColumn}`,
        );
      }

      // Derive navigation name: author_id → author
      const navField = fkColumn.replace(/_id$/, "");

      // belongs-to: books.author_id → authors
      const btKey = `${fromTable}.${fkColumn}:belongs-to`;
      if (!added.has(btKey)) {
        relationships.push({
          type: "belongs-to",
          from: fromTable,
          to: toTable,
          relationshipField: navigationName(fromTable, navField),
          foreignKey: fkColumn,
        });
        added.add(btKey);
      }

      // auto-infer one-to-many inverse: authors.books → books[]
      const otmKey = `${toTable}.${fromTable}:one-to-many`;
      if (added.has(otmKey)) {
        throw new Error(
          `relations: ambiguous inverse from '${toTable}' to '${fromTable}'; multiple foreign keys require explicit navigation`,
        );
      }
      if (!added.has(otmKey)) {
        relationships.push({
          type: "one-to-many",
          from: toTable,
          to: fromTable,
          relationshipField: navigationName(toTable, fromTable), // e.g. 'books'
          foreignKey: "",
        });
        added.add(otmKey);
      }
    }
  }

  return relationships;
}

/** Get storable (non-id) fields from a schema */
export function getStorableFields(
  schema: z.ZodType<any>,
): { name: string; type: ZodType }[] {
  return Object.entries(asZodObject(schema).shape)
    .filter(([key]) => key !== "id")
    .map(([name, type]) => ({ name, type: type as ZodType }));
}

/** Map a Zod type to its SQLite column type */
export function zodTypeToSqlType(zodType: ZodType): string {
  // Zod 4's unwrap() returns the core $ZodType, not necessarily the public
  // ZodType interface. Narrow by runtime constructor after unwrapping.
  let inner: z.core.$ZodType = zodType;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodPrefault ||
    inner instanceof z.ZodReadonly ||
    inner instanceof z.ZodNonOptional
  ) {
    inner = inner.unwrap();
  }
  if (inner instanceof z.ZodString || inner instanceof z.ZodDate)
    return "TEXT";
  if (inner instanceof z.ZodNumber || inner instanceof z.ZodBoolean)
    return "INTEGER";
  if (inner instanceof z.ZodEnum) return "TEXT";
  if (
    inner instanceof z.ZodCustom &&
    inner.safeParse(Buffer.alloc(0)).success &&
    !inner.safeParse("").success
  )
    return "BLOB";
  // z.object(), z.array(), z.record() → stored as JSON TEXT
  return "TEXT";
}

/** Transform JS values to SQLite storage format */
export function transformForStorage(
  data: Record<string, any>,
): Record<string, any> {
  const transformed: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Date) {
      transformed[key] = value.toISOString();
    } else if (typeof value === "boolean") {
      transformed[key] = value ? 1 : 0;
    } else if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !(value instanceof Buffer)
    ) {
      // Auto-serialize objects and arrays to JSON
      transformed[key] = JSON.stringify(value);
    } else {
      transformed[key] = value;
    }
  }
  return transformed;
}

/** Transform SQLite row back to JS types based on schema */
export function transformFromStorage(
  row: Record<string, any>,
  schema: z.ZodType<any>,
): Record<string, any> {
  const transformed: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    let fieldSchema = asZodObject(schema).shape[key];
    while (
      fieldSchema instanceof z.ZodOptional ||
      fieldSchema instanceof z.ZodNullable ||
      fieldSchema instanceof z.ZodDefault ||
      fieldSchema instanceof z.ZodPrefault ||
      fieldSchema instanceof z.ZodReadonly ||
      fieldSchema instanceof z.ZodNonOptional
    ) {
      fieldSchema = fieldSchema.unwrap();
    }
    if (fieldSchema instanceof z.ZodDate && typeof value === "string") {
      transformed[key] = new Date(value);
    } else if (
      fieldSchema instanceof z.ZodBoolean &&
      typeof value === "number"
    ) {
      transformed[key] = value === 1;
    } else if (isJsonSchema(fieldSchema) && typeof value === "string") {
      // Auto-parse JSON columns
      try {
        transformed[key] = JSON.parse(value);
      } catch {
        transformed[key] = value;
      }
    } else {
      transformed[key] = value;
    }
  }
  return transformed;
}

/** Check if a Zod schema represents a JSON-serializable type */
function isJsonSchema(schema: any): boolean {
  if (!schema) return false;
  return (
    schema instanceof z.ZodObject ||
    schema instanceof z.ZodArray ||
    schema instanceof z.ZodRecord ||
    schema instanceof z.ZodTuple ||
    schema instanceof z.ZodUnion ||
    schema instanceof z.ZodDiscriminatedUnion
  );
}
