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
  const navigationNames = new Set<string>();
  const reserved = new Set([
    "id", "update", "delete", "createdAt", "updatedAt", "deletedAt",
  ]);
  const navigationName = (table: string, base: string, inverse = false) => {
    const shape = asZodObject(schemas[table]!).shape;
    let name = base;
    while (
      Object.prototype.hasOwnProperty.call(shape, name) ||
      reserved.has(name) ||
      (inverse && navigationNames.has(`${table}.${name}`))
    ) name += "Relation";
    const key = `${table}.${name}`;
    if (navigationNames.has(key))
      throw new Error(`relations: conflicting navigation accessor '${key}'`);
    navigationNames.add(key);
    return name;
  };

  const entries: { child: string; parent: string; fk: string }[] = [];
  const counts = new Map<string, number>();
  for (const [child, rels] of Object.entries(relations)) {
    if (!schemas[child]) throw new Error(`relations: unknown table '${child}'`);
    for (const [fk, parent] of Object.entries(rels)) {
      if (!schemas[parent])
        throw new Error(`relations: unknown target table '${parent}' in ${child}.${fk}`);
      entries.push({ child, parent, fk });
      const key = JSON.stringify([child, parent]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Allocate forward names before inverse names (including self-references).
  for (const { child, parent, fk } of entries) {
    relationships.push({
      type: "belongs-to", from: child, to: parent,
      relationshipField: navigationName(child, fk.replace(/_id$/, "")),
      foreignKey: fk,
    });
  }
  for (const { child, parent, fk } of entries) {
    // Qualify *all* inverses for a repeated child/parent pair, regardless of
    // declaration order. Self inverses are always qualified.
    const qualified = child === parent || counts.get(JSON.stringify([child, parent]))! > 1;
    const base = qualified
      ? `${child}By${fk.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("")}`
      : child;
    relationships.push({
      type: "one-to-many", from: parent, to: child,
      relationshipField: navigationName(parent, base, true),
      foreignKey: fk,
    });
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
  schema?: z.ZodType<any>,
): Record<string, any> {
  const transformed: Record<string, any> = {};
  const shape = schema ? asZodObject(schema).shape : undefined;
  for (const [key, value] of Object.entries(data)) {
    if (shape && value !== null && value !== undefined && !(value instanceof Buffer) &&
        isAnyValueSchema(unwrapField(shape[key]))) {
      // z.any()/z.unknown(): store every value as JSON so it reads back with its type.
      transformed[key] = JSON.stringify(value, (_key, v) =>
        typeof v === "bigint" ? v.toString() : v);
    } else if (value instanceof Date) {
      transformed[key] = value.toISOString();
    } else if (typeof value === "boolean") {
      transformed[key] = value ? 1 : 0;
    } else if (typeof value === "bigint") {
      transformed[key] = value.toString();
    } else if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !(value instanceof Buffer)
    ) {
      // Auto-serialize objects and arrays to JSON
      transformed[key] = JSON.stringify(value, (_key, v) =>
        typeof v === "bigint" ? v.toString() : v);
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
    const fieldSchema = unwrapField(asZodObject(schema).shape[key]);
    if (isAnyValueSchema(fieldSchema) && typeof value === "string") {
      // JSON written by 4.0.2+; plain text written by older versions stays as it is.
      try {
        transformed[key] = JSON.parse(value);
      } catch {
        transformed[key] = value;
      }
    } else if (fieldSchema instanceof z.ZodDate && typeof value === "string") {
      transformed[key] = new Date(value);
    } else if (
      fieldSchema instanceof z.ZodBoolean &&
      typeof value === "number"
    ) {
      transformed[key] = value === 1;
    } else if (fieldSchema instanceof z.ZodBigInt && typeof value === "string") {
      transformed[key] = BigInt(value);
    } else if (fieldSchema instanceof z.ZodLiteral && typeof value === "number" &&
        [...fieldSchema.values].some(v => typeof v === "boolean" && Number(v) === value)) {
      transformed[key] = value === 1;
    } else if (fieldSchema instanceof z.ZodLiteral && typeof value === "string" &&
        [...fieldSchema.values].some(v => typeof v === "bigint" && v.toString() === value)) {
      transformed[key] = BigInt(value);
    } else if (isJsonSchema(fieldSchema) && typeof value === "string") {
      // Auto-parse JSON columns
      try {
        transformed[key] = revive(JSON.parse(value), fieldSchema);
      } catch {
        transformed[key] = value;
      }
    } else {
      transformed[key] = value;
    }
  }
  return transformed;
}

/** Decode JSON using its schema; an ISO-looking z.string() stays a string. */
function revive(value: any, schema: z.core.$ZodType | undefined): any {
  while (
    schema instanceof z.ZodOptional || schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodReadonly || schema instanceof z.ZodNonOptional
  ) schema = schema.unwrap();
  if (value == null || !schema) return value;
  if (schema instanceof z.ZodDate && typeof value === "string") return new Date(value);
  if (schema instanceof z.ZodBoolean && typeof value === "number") return value === 1;
  if (schema instanceof z.ZodBigInt && typeof value === "string") return BigInt(value);
  if (schema instanceof z.ZodLiteral) {
    for (const v of schema.values) {
      if (typeof v === "boolean" && typeof value === "number" && Number(v) === value)
        return v;
      if (typeof v === "bigint" && typeof value === "string" && v.toString() === value)
        return v;
    }
  }
  if (schema instanceof z.ZodArray && Array.isArray(value))
    return value.map(v => revive(v, schema.element));
  if (schema instanceof z.ZodTuple && Array.isArray(value))
    return value.map((v, i) => revive(v, (schema as any).def.items[i]));
  if (schema instanceof z.ZodObject && typeof value === "object" && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, revive(v, schema.shape[k])]));
  if (schema instanceof z.ZodRecord && typeof value === "object" && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, revive(v, schema.valueType)]));
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      const candidate = revive(value, option);
      if ((option as z.ZodType).safeParse(candidate).success) return candidate;
    }
  }
  return value;
}

/** Check if a Zod schema represents a JSON-serializable type */
function unwrapField(fieldSchema: any): any {
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
  return fieldSchema;
}

function isAnyValueSchema(schema: any): boolean {
  return schema instanceof z.ZodAny || schema instanceof z.ZodUnknown;
}

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
