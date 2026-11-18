/**
 * types.ts — All type definitions for sqlite-zod-orm
 *
 * NavEntity<S, R, Table> computes navigation methods from the relations config
 * at the type level — full autocomplete on schema fields AND relationship methods.
 */
import { z } from "zod";
import type { QueryBuilder } from "./query";

export type ZodType = z.ZodType;
export type SchemaMap = Record<string, z.ZodType<any>>;
export type ViewSchemaMap = Record<string, z.ZodType<any>>;

/** Relations config: `{ childTable: { fkColumn: 'parentTable' } }` */
export type RelationsConfig = Record<string, Record<string, string>>;

/** Internal cast: all schemas are z.object() at runtime */
export const asZodObject = (s: z.ZodType<any>) =>
  s as unknown as z.ZodObject<any>;

/** Index definition: single column or composite columns */
export type IndexDef = string | string[];

export type ViewDefinition<S extends z.ZodType<any> = z.ZodType<any>> = {
  schema: S;
  as: string;
};

export type ViewDefinitions = Record<string, ViewDefinition<z.ZodType<any>>>;

export function defineView<S extends z.ZodType<any>>(
  schema: S,
  as: string,
): ViewDefinition<S> {
  return { schema, as };
}

/** Lifecycle hooks for a single table. */
export type TableHooks = {
  beforeInsert?: (data: Record<string, any>) => Record<string, any> | void;
  afterInsert?: (entity: Record<string, any>) => void;
  beforeUpdate?: (
    data: Record<string, any>,
    id: number,
  ) => Record<string, any> | void;
  afterUpdate?: (entity: Record<string, any>) => void;
  beforeDelete?: (id: number) => false | void;
  afterDelete?: (id: number) => void;
  /** Return false to cancel a restore (softDeletes). */
  beforeRestore?: (id: number) => false | void;
  afterRestore?: (id: number) => void;
};

export type DatabaseOptions<
  R extends RelationsConfig = RelationsConfig,
  V extends ViewDefinitions = {},
> = {
  indexes?: Record<string, IndexDef[]>;
  /**
   * Unique constraints per table. Each entry is an array of column groups.
   * Single column: `{ users: [['email']] }` → UNIQUE INDEX.
   * Compound: `{ users: [['email'], ['name', 'org_id']] }` → two UNIQUE indexes.
   */
  unique?: Record<string, string[][]>;
  /**
   * Declare relationships between tables.
   *
   * Format: `{ childTable: { fkColumn: 'parentTable' } }`
   *
   * `books: { author_id: 'authors' }` → FOREIGN KEY, lazy nav, fluent join.
   */
  relations?: R;
  /**
   * Global polling interval (ms) for `.on()` change listeners.
   * A single poller serves all listeners. Default: 100ms.
   * Ignored if `reactive` is false.
   */
  pollInterval?: number;
  /**
   * Enable trigger-based change tracking for `.on()` listeners.
   * Set to `false` to skip trigger/table creation entirely — calling
   * `.on()` will throw. Default: `true`.
   */
  reactive?: boolean;
  /**
   * Auto-add `createdAt` and `updatedAt` TEXT columns to every table.
   * `createdAt` is set on insert, `updatedAt` on insert + update.
   * Default: `false`.
   */
  timestamps?: boolean;
  /**
   * Enable soft deletes. Adds a `deletedAt` TEXT column to every table.
   * `delete()` sets `deletedAt` instead of removing the row.
   * Use `.withTrashed()` on queries to include soft-deleted rows.
   * Default: `false`.
   */
  softDeletes?: boolean;
  /**
   * Field renames applied when a schema change rebuilds a table: the old
   * column's values are copied into the new field instead of leaving it
   * empty. `{ users: { name: "fullName" } }` renames users.name to fullName.
   * Once the old column is gone the entry does nothing, so it can stay.
   */
  renames?: Record<string, Record<string, string>>;
  /**
   * Log every SQL query to the console. Useful for debugging.
   * Default: `false`.
   */
  debug?: boolean;
  /**
   * Enable WAL (Write-Ahead Logging) journal mode for better
   * concurrent read/write performance. Recommended for production.
   * Default: `true`.
   */
  wal?: boolean;
  /** SQLite lock wait in milliseconds, set before WAL/schema work. Default: 5000. */
  busyTimeout?: number;
  /**
   * Lifecycle hooks per table. Each hook receives data and can transform it.
   *
   * - `beforeInsert(data)` — called before insert, return modified data or void
   * - `afterInsert(entity)` — called after insert with the persisted entity
   * - `beforeUpdate(data, id)` — called before update, return modified data or void
   * - `afterUpdate(entity)` — called after update with the updated entity
   * - `beforeDelete(id)` — called before delete, return false to cancel
   * - `afterDelete(id)` — called after delete
   */
  hooks?: Record<string, TableHooks>;
  /**
   * Computed/virtual getters per table. Injected on every read.
   * ```ts
   * computed: { users: { fullName: (u) => u.first + ' ' + u.last } }
   * ```
   */
  computed?: Record<
    string,
    Record<string, (entity: Record<string, any>) => any>
  >;
  /**
   * Cascade delete config per table. When a parent is deleted, children are auto-deleted.
   * ```ts
   * cascade: { authors: ['books'] }  // deleting author → deletes their books
   * ```
   */
  cascade?: Record<string, string[]>;
  /**
   * Read-only SQLite views created from declarative definitions.
   * Each entry provides a Zod schema for typed reads and the SELECT body.
   */
  views?: V;
};

export type TransactionOptions = {
  /** Acquire the write lock before reading. Default: "immediate". */
  mode?: "immediate" | "deferred" | "exclusive";
};

export type Relationship = {
  type: "belongs-to" | "one-to-many";
  from: string;
  to: string;
  relationshipField: string;
  /** Actual child-table FK column, for both belongs-to and one-to-many. */
  foreignKey: string;
};

export type InferSchema<S extends z.ZodType<any>> = z.infer<S>;
export type InputSchema<S extends z.ZodType<any>> = z.input<S>;
/** SQLite allocates an id when omitted, but also accepts a supplied numeric id. */
export type EntityData<S extends z.ZodType<any>> =
  Omit<InputSchema<S>, "id"> & { id?: number };

/** Partial writes never change the SQLite identity column. */
export type UpdateData<S extends z.ZodType<any>> =
  Partial<Omit<InputSchema<S>, "id">> & { id?: never };

/** Runtime-installed columns are only available when their options are literally true. */
export type GeneratedColumns<O> =
  (O extends { timestamps: true }
    ? { createdAt: string; updatedAt: string }
    : {}) &
  (O extends { softDeletes: true }
    ? { deletedAt: string | null }
    : {});

/** Filter out entity navigation and mutation methods: they are not SQL columns. */
export type StoredColumns<T> = Pick<T, {
  [K in keyof T]-?: T[K] extends (...args: any[]) => any ? never : K
}[keyof T]>;

/** `where()` consumes scalar values or supported per-field operator objects. */
export type FieldOperators<V> = {
  $gt?: Exclude<V, undefined>;
  $gte?: Exclude<V, undefined>;
  $lt?: Exclude<V, undefined>;
  $lte?: Exclude<V, undefined>;
  $ne?: Exclude<V, undefined> | null;
  $in?: Exclude<V, undefined>[];
  $notIn?: Exclude<V, undefined>[];
  $between?: [Exclude<V, undefined>, Exclude<V, undefined>];
  // SQLite LIKE also operates on non-TEXT columns by coercion.
  $like?: string;
  $isNull?: boolean;
  $isNotNull?: boolean;
};
export type WhereFields<T> = {
  [K in keyof StoredColumns<T>]?: StoredColumns<T>[K] | null |
    FieldOperators<StoredColumns<T>[K]>;
};
export type WhereInput<T> = WhereFields<T> & {
  $or?: WhereFields<T>[];
};

/** Raw SQL reads do not run schema deserializers or attach entity methods. */
/**
 * What SQLite hands back for a field without parsing. `boolean` is checked
 * before distributing: a distributive check sees `true | false` as two
 * literals (stored as text) and widened z.boolean() to `number | string`.
 */
export type RawValue<V> = [NonNullable<V>] extends [never] ? V
  : [NonNullable<V>] extends [boolean]
    ? (boolean extends NonNullable<V> ? number : number | string) | Extract<V, null | undefined>
    : RawValueEach<V>;
type RawValueEach<V> = V extends null | undefined ? V
  : V extends Date ? string
  : V extends boolean ? (boolean extends V ? number : number | string)
  : V extends number ? (number extends V ? number : string)
  : V extends bigint ? string
  : V extends Uint8Array ? Uint8Array
  : V extends object ? string
  : V;
export type RawRow<T> = {
  [K in keyof StoredColumns<T>]: RawValue<StoredColumns<T>[K]>;
};


// Navigation Type Inference (simple approach)
// =============================================================================

/** Strip `_id` suffix: `'author_id'` → `'author'` */
type StripIdSuffix<S extends string> = S extends `${infer Base}_id` ? Base : S;

/** Append Relation for columns, entity methods, or already-used forward names. */
type NavigationName<
  S extends z.ZodType<any>,
  Name extends string,
  Used extends string = never,
> = string extends keyof z.infer<S>
  ? Name
  : Name extends keyof z.infer<S> | "id" | "update" | "delete" | "createdAt" | "updatedAt" | "deletedAt" | Used
    ? NavigationName<S, `${Name}Relation`, Used>
    : Name;

type FKsTo<Rec, Parent extends string> = {
  [FK in Extract<keyof Rec, string>]: Rec[FK] extends Parent ? FK : never;
}[Extract<keyof Rec, string>];

type IsUnion<T, C = T> = T extends C ? [C] extends [T] ? false : true : never;
type PascalFK<FK extends string> = FK extends `${infer Head}_${infer Tail}`
  ? `${Capitalize<Head>}${PascalFK<Tail>}`
  : Capitalize<FK>;

type InverseBase<
  R extends RelationsConfig,
  Child extends keyof R & string,
  Parent extends string,
  FK extends string,
> = Child extends Parent
  ? `${Child}By${PascalFK<FK>}`
  : IsUnion<FKsTo<R[Child], Parent>> extends true
    ? `${Child}By${PascalFK<FK>}`
    : Child;

/**
 * Base entity type with schema fields, id, update(), delete().
 * No nav methods — those are added by NavMethods.
 */
type BaseEntity<S extends z.ZodType<any>, O = {}> = z.infer<S> & GeneratedColumns<O> & {
  id: number;
  update: (data: UpdateData<S>) => BaseEntity<S, O> | null;
  delete: () => void;
};

/**
 * Belongs-to nav methods for a table.
 * `books: { author_id: 'authors' }` → book gets `{ author: () => BaseEntity<AuthorSchema> | null }`
 */
type BelongsToNav<
  S extends SchemaMap,
  R extends RelationsConfig,
  Table extends string,
  O = {},
> = Table extends keyof R
  ? {
      readonly [
        FK in Extract<keyof R[Table], string> as NavigationName<S[Table & keyof S], StripIdSuffix<FK>>
      ]: R[Table][FK] extends keyof S
        ? () => BaseEntity<S[R[Table][FK]], O> | null
        : never;
    }
  : {};

/** Has-many accessors are keyed by each specific child FK, not table pair. */
type HasManyForChild<
  S extends SchemaMap,
  R extends RelationsConfig,
  Parent extends string,
  Child extends Extract<keyof R & keyof S, string>,
  O = {},
> = {
  readonly [FK in FKsTo<R[Child], Parent> as NavigationName<
    S[Parent & keyof S],
    InverseBase<R, Child, Parent, FK>,
    Extract<keyof BelongsToNav<S, R, Parent>, string>
  >]: () => BaseEntity<S[Child], O>[];
};

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends ((value: infer I) => void) ? I : {};

type HasManyNav<
  S extends SchemaMap,
  R extends RelationsConfig,
  Parent extends string,
  O = {},
> = UnionToIntersection<{
  [Child in Extract<keyof R & keyof S, string>]:
    HasManyForChild<S, R, Parent, Child, O>;
}[Extract<keyof R & keyof S, string>]>;

// =============================================================================
// NavEntity — Full entity type with nav methods (one level deep)
// =============================================================================

/**
 * A fully typed entity returned from the ORM.
 *
 * Nav methods return BaseEntity (one level deep typing).
 * Calling `book.author()` gives you a typed entity, and calling
 * `.books()` on that result works at runtime, just without
 * the second level of nav method types.
 */
export type NavEntity<
  S extends SchemaMap,
  R extends RelationsConfig,
  Table extends string,
  O = {},
> = BaseEntity<S[Table & keyof S], O> &
  BelongsToNav<S, R, Table, O> &
  HasManyNav<S, R, Table, O>;

/** Relation metadata for eager load inference, preserving both FK directions. */
type ForwardRelations<S extends SchemaMap, R extends RelationsConfig, T extends string> =
  T extends keyof R ? {
    [FK in Extract<keyof R[T], string> as NavigationName<
      S[T & keyof S], StripIdSuffix<FK>
    >]: R[T][FK] extends keyof S
      ? { table: Extract<R[T][FK], keyof S & string>; many: false }
      : never;
  } : {};

type InverseRelationsFor<
  S extends SchemaMap, R extends RelationsConfig, Parent extends string,
  Child extends Extract<keyof R & keyof S, string>
> = {
  [FK in FKsTo<R[Child], Parent> as NavigationName<
    S[Parent & keyof S], InverseBase<R, Child, Parent, FK>,
    Extract<keyof BelongsToNav<S, R, Parent>, string>
  >]: { table: Child; many: true };
};

type InverseRelations<S extends SchemaMap, R extends RelationsConfig, T extends string> =
  UnionToIntersection<{
    [Child in Extract<keyof R & keyof S, string>]:
      InverseRelationsFor<S, R, T, Child>
  }[Extract<keyof R & keyof S, string>]>;

type RelationMap<S extends SchemaMap, R extends RelationsConfig, T extends string> =
  ForwardRelations<S, R, T> & InverseRelations<S, R, T>;

type PathHead<P extends string> = P extends `${infer H}.${string}` ? H : P;
type PathTail<P extends string, K extends string> =
  P extends `${K}.${infer Tail}` ? Tail : never;

type EagerColumn<
  S extends SchemaMap, R extends RelationsConfig, Info, Tail extends string,
  Depth extends unknown[], O
> = Info extends { table: infer Child extends keyof S & string; many: infer Many }
  ? Many extends true
    ? EagerWith<NavEntity<S, R, Child, O>, S, R, Child, Tail, Depth, O>[]
    : EagerWith<NavEntity<S, R, Child, O>, S, R, Child, Tail, Depth, O> | null
  : never;

type EagerPatch<
  S extends SchemaMap, R extends RelationsConfig, T extends string,
  Paths extends string, Depth extends unknown[], O
> = {
  [K in Extract<keyof RelationMap<S, R, T>, PathHead<Paths>>]:
    EagerColumn<S, R, RelationMap<S, R, T>[K], PathTail<Paths, K>, [...Depth, 0], O>;
};

/**
 * Eager relations replace lazy methods with their actual values. A selected
 * projection without `id` cannot be eagerly hydrated by the runtime.
 * Stops traversing at depth four to bound compiler work.
 */
export type EagerWith<
  T, S extends SchemaMap, R extends RelationsConfig, Table extends string,
  Paths extends string, Depth extends unknown[] = [], O = {}
> = [Table] extends [never] ? T
  : "id" extends keyof T
    ? Depth["length"] extends 4 ? T
      : Omit<T, keyof EagerPatch<S, R, Table, Paths, Depth, O>> &
        EagerPatch<S, R, Table, Paths, Depth, O>
    : T;

// =============================================================================
// Entity Accessors
// =============================================================================

/** Fluent update builder */
export type UpdateBuilder<T> = {
  where: (conditions: WhereInput<T>) => UpdateBuilder<T>;
  exec: () => number;
};

/** Fluent delete builder */
export type DeleteBuilder<T> = {
  where: (conditions: WhereInput<T>) => DeleteBuilder<T>;
  exec: () => number;
};

export type ConflictColumn<T> = Extract<keyof StoredColumns<T>, string> | "id";

export type ConflictExpression = {
  readonly sql: string;
  readonly params: any[];
};

export type ConflictMergeHelpers<T> = {
  current: <K extends ConflictColumn<T>>(field: K) => ConflictExpression;
  excluded: <K extends ConflictColumn<T>>(field: K) => ConflictExpression;

  /** New value wins unless it is NULL. */
  excludedIfNotNull: <K extends ConflictColumn<T>>(
    field: K,
  ) => ConflictExpression;

  /** New value wins unless it is NULL or ''. */
  excludedIfNotEmpty: <K extends ConflictColumn<T>>(
    field: K,
  ) => ConflictExpression;

  /** First non-null value wins; current value is kept once present. */
  keepFirst: <K extends ConflictColumn<T>>(field: K) => ConflictExpression;

  /** Greater numeric value wins. */
  max: <K extends ConflictColumn<T>>(
    field: K,
    fallback?: number,
  ) => ConflictExpression;

  // Backwards-compatible verbose aliases.
  coalesceExcluded: <K extends ConflictColumn<T>>(
    field: K,
  ) => ConflictExpression;
  coalesceExcludedNonEmpty: <K extends ConflictColumn<T>>(
    field: K,
  ) => ConflictExpression;
  coalesceCurrentExcluded: <K extends ConflictColumn<T>>(
    field: K,
  ) => ConflictExpression;
  keepExistingIfExcludedEmpty: <K extends ConflictColumn<T>>(
    field: K,
  ) => ConflictExpression;
  maxCurrentExcluded: <K extends ConflictColumn<T>>(
    field: K,
    fallback?: number,
  ) => ConflictExpression;

  literal: (value: any) => ConflictExpression;
  sql: (fragment: string, params?: any[]) => ConflictExpression;
};

export type UpsertConflictOptions<T> = {
  /** Column or columns used by SQLite's ON CONFLICT (...) target. */
  on: ConflictColumn<T> | ConflictColumn<T>[];
} & (
  | {
      /** Per-column merge rules. Compiles to ON CONFLICT (...) DO UPDATE SET ... */
      merge: (
        t: ConflictMergeHelpers<T>,
      ) => Partial<Record<ConflictColumn<T>, ConflictExpression>>;
      doNothing?: never;
    }
  | {
      /** Insert if missing; if the conflict target already exists, leave the row unchanged. */
      doNothing: true;
      merge?: never;
    }
);

/** Nav-aware entity accessor for a specific table */
export type NavEntityAccessor<
  S extends SchemaMap,
  R extends RelationsConfig,
  Table extends string,
  O = {},
> = {
  get: (id: number) => NavEntity<S, R, Table, O> | null;
  insert: (
    data: EntityData<S[Table & keyof S]>,
  ) => NavEntity<S, R, Table, O>;
  insertMany: (
    rows: EntityData<S[Table & keyof S]>[],
  ) => NavEntity<S, R, Table, O>[];
  update: ((
    id: number,
    data: UpdateData<S[Table & keyof S]>,
  ) => NavEntity<S, R, Table, O> | null) &
    ((
      data: UpdateData<S[Table & keyof S]>,
    ) => UpdateBuilder<NavEntity<S, R, Table, O>>);
  upsert: ((
    conditions?: Partial<z.input<S[Table & keyof S]>>,
    data?: Partial<z.input<S[Table & keyof S]>>,
  ) => NavEntity<S, R, Table, O>) &
    ((
      data: EntityData<S[Table & keyof S]>,
      options: UpsertConflictOptions<NavEntity<S, R, Table, O>>,
    ) => NavEntity<S, R, Table, O>);
  /** Compatibility alias for the native conflict-upsert path. Prefer `.upsert(row, { on, merge })`. */
  upsertOnConflict: (
    data: EntityData<S[Table & keyof S]>,
    target:
      | ConflictColumn<NavEntity<S, R, Table, O>>
      | ConflictColumn<NavEntity<S, R, Table, O>>[],
    merge: (
      t: ConflictMergeHelpers<NavEntity<S, R, Table, O>>,
    ) => Partial<
      Record<ConflictColumn<NavEntity<S, R, Table, O>>, ConflictExpression>
    >,
  ) => NavEntity<S, R, Table, O>;
  upsertMany: (
    // id is allocated by SQLite and is a valid match key for existing rows.
    rows: (Partial<z.input<S[Table & keyof S]>> & { id?: number })[],
    conditions?: Partial<z.input<S[Table & keyof S]>>,
  ) => NavEntity<S, R, Table, O>[];
  findOrCreate: (
    conditions: Partial<z.input<S[Table & keyof S]>>,
    defaults?: Partial<z.input<S[Table & keyof S]>>,
  ) => { entity: NavEntity<S, R, Table, O>; created: boolean };
  delete: ((id: number) => void) &
    (() => DeleteBuilder<NavEntity<S, R, Table, O>>);
  restore: (id: number) => void;
  select: {
    (): QueryBuilder<NavEntity<S, R, Table, O>, NavEntity<S, R, Table, O>, S, R, Table, false, O>;
    <K extends (keyof z.infer<S[Table & keyof S]> | keyof GeneratedColumns<O> | "id") & string>(
      ...cols: K[]
    ): QueryBuilder<NavEntity<S, R, Table, O>, Pick<NavEntity<S, R, Table, O>, K>, S, R, Table, true, O>;
  };
  count: () => number;
  on: ((
    event: "insert" | "update",
    callback: (row: NavEntity<S, R, Table, O>) => void | Promise<void>,
  ) => () => void) &
    ((
      event: "delete",
      callback: (row: { id: number }) => void | Promise<void>,
    ) => () => void);
  _tableName: string;
  readonly _schema?: S[Table & keyof S];
};

/** Map each table in the schema to its nav-aware accessor */
export type TypedNavAccessors<
  S extends SchemaMap,
  R extends RelationsConfig,
  O = {},
> = {
  [K in Extract<keyof S, string>]: NavEntityAccessor<S, R, K, O>;
};

// =============================================================================
// Legacy types (used internally by _Database class)
// =============================================================================

export type AugmentedEntity<S extends z.ZodType<any>> = InferSchema<S> & {
  id: number;
  update: (data: UpdateData<S>) => AugmentedEntity<S> | null;
  delete: () => void;
};

export type ChangeEvent = "insert" | "update" | "delete";

export type ReadonlyEntity<S extends z.ZodType<any>> = InferSchema<S>;

export type EntityAccessor<S extends z.ZodType<any>> = {
  get: (id: number) => AugmentedEntity<S> | null;
  insert: (data: EntityData<S>) => AugmentedEntity<S>;
  insertMany: (rows: EntityData<S>[]) => AugmentedEntity<S>[];
  update: ((
    id: number,
    data: UpdateData<S>,
  ) => AugmentedEntity<S> | null) &
    ((data: UpdateData<S>) => UpdateBuilder<AugmentedEntity<S>>);
  upsert: ((
    conditions?: Partial<InferSchema<S>>,
    data?: Partial<InferSchema<S>>,
  ) => AugmentedEntity<S>) &
    ((
      data: EntityData<S>,
      options: UpsertConflictOptions<AugmentedEntity<S>>,
    ) => AugmentedEntity<S>);
  /** Compatibility alias for the native conflict-upsert path. Prefer `.upsert(row, { on, merge })`. */
  upsertOnConflict: (
    data: EntityData<S>,
    target:
      ConflictColumn<AugmentedEntity<S>> | ConflictColumn<AugmentedEntity<S>>[],
    merge: (
      t: ConflictMergeHelpers<AugmentedEntity<S>>,
    ) => Partial<
      Record<ConflictColumn<AugmentedEntity<S>>, ConflictExpression>
    >,
  ) => AugmentedEntity<S>;
  upsertMany: (
    // Existing rows can be matched by the generated SQLite id, just like
    // upsert(). The id is not a property of the user's Zod schema.
    rows: (Partial<InferSchema<S>> & { id?: number })[],
    conditions?: Partial<InferSchema<S>>,
  ) => AugmentedEntity<S>[];
  findOrCreate: (
    conditions: Partial<InferSchema<S>>,
    defaults?: Partial<InferSchema<S>>,
  ) => { entity: AugmentedEntity<S>; created: boolean };
  delete: ((id: number) => void) & (() => DeleteBuilder<AugmentedEntity<S>>);
  /** Undo a soft delete by setting deletedAt = null. Requires softDeletes. */
  restore: (id: number) => void;
  select: {
    (): QueryBuilder<AugmentedEntity<S>>;
    <K extends (keyof InferSchema<S> | "id") & string>(
      ...cols: K[]
    ): QueryBuilder<AugmentedEntity<S>, Pick<AugmentedEntity<S>, K>>;
  };
  count: () => number;
  on: ((
    event: "insert" | "update",
    callback: (row: AugmentedEntity<S>) => void | Promise<void>,
  ) => () => void) &
    ((
      event: "delete",
      callback: (row: { id: number }) => void | Promise<void>,
    ) => () => void);
  _tableName: string;
  readonly _schema?: S;
};

export type TypedAccessors<T extends SchemaMap> = {
  [K in keyof T]: EntityAccessor<T[K]>;
};

export type ReadonlyEntityAccessor<S extends z.ZodType<any>> = {
  select: {
    (): QueryBuilder<ReadonlyEntity<S>, ReadonlyEntity<S>, {}, {}, never, false, {}, false>;
    <K extends keyof InferSchema<S> & string>(
      ...cols: K[]
    ): QueryBuilder<ReadonlyEntity<S>, Pick<ReadonlyEntity<S>, K>, {}, {}, never, true, {}, false>;
  };
  count: () => number;
  _tableName: string;
  readonly _schema?: S;
  readonly _isView: true;
};

export type TypedReadonlyAccessors<T extends ViewSchemaMap> = {
  [K in keyof T]: ReadonlyEntityAccessor<T[K]>;
};

import type { ColumnNode } from "./query";

export type ColumnRef = ColumnNode & string;

export type ProxyColumns<T> = Required<{ [K in keyof T]: ColumnRef }> & {
  id: ColumnRef;
  [k: string]: ColumnRef;
};
