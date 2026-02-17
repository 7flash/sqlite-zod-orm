/**
 * types.ts — All type definitions for sqlite-zod-orm
 */
import { z } from 'zod';
import type { QueryBuilder } from './query-builder';

export type ZodType = z.ZodTypeAny;
export type SchemaMap = Record<string, z.ZodType<any>>;

/** Internal cast: all schemas are z.object() at runtime */
export const asZodObject = (s: z.ZodType<any>) => s as unknown as z.ZodObject<any>;

/** Index definition: single column or composite columns */
export type IndexDef = string | string[];

/** Options for the Database constructor */
export type DatabaseOptions = {
    /** Enable trigger-based change tracking for efficient subscribe polling */
    changeTracking?: boolean;
    /** Index definitions per table: { tableName: ['col1', ['col2', 'col3']] } */
    indexes?: Record<string, IndexDef[]>;
    /**
     * Declare relationships between tables.
     *
     * Format: `{ childTable: { fkColumn: 'parentTable' } }`
     *
     * `books: { author_id: 'authors' }` means books.author_id is a FK
     * referencing authors.id.
     *
     * The ORM auto-creates:
     * - FOREIGN KEY constraint on the FK column
     * - Inverse one-to-many (`author.books()`)
     * - Lazy navigation (`book.author()` — derived by stripping `_id`)
     */
    relations?: Record<string, Record<string, string>>;
};

export type Relationship = {
    type: 'belongs-to' | 'one-to-many';
    from: string;
    to: string;
    relationshipField: string;
    foreignKey: string;
};

// --- Type helpers ---

export type InferSchema<S extends z.ZodType<any>> = z.infer<S>;

/** Input type: fields with .default() become optional */
export type InputSchema<S extends z.ZodType<any>> = z.input<S>;

export type EntityData<S extends z.ZodType<any>> = Omit<InputSchema<S>, 'id'>;

/**
 * An entity returned from the ORM. Has all schema fields + `id` +
 * `update()`/`delete()` methods.
 *
 * Lazy navigation methods (e.g. `book.author()`, `author.books()`)
 * are attached at runtime based on the `relations` config. They are
 * typed as `(...args: any[]) => any` to avoid nuking intellisense.
 */
export type AugmentedEntity<S extends z.ZodType<any>> = InferSchema<S> & {
    /** Auto-generated primary key */
    id: number;
    /** Update this entity in the database */
    update: (data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
    /** Delete this entity from the database */
    delete: () => void;
};

/** Fluent update builder: `db.users.update({ level: 10 }).where({ name: 'Alice' }).exec()` */
export type UpdateBuilder<T> = {
    /** Set filter conditions for the update */
    where: (conditions: Record<string, any>) => UpdateBuilder<T>;
    /** Execute the update and return the number of rows affected */
    exec: () => number;
};

export type EntityAccessor<S extends z.ZodType<any>> = {
    insert: (data: EntityData<S>) => AugmentedEntity<S>;
    update: ((id: number, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null) & ((data: Partial<EntityData<S>>) => UpdateBuilder<AugmentedEntity<S>>);
    upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
    delete: (id: number) => void;
    subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
    unsubscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
    select: (...cols: (keyof InferSchema<S> & string)[]) => QueryBuilder<AugmentedEntity<S>>;
    _tableName: string;
    /** Phantom field for carrying schema type info to .join() */
    readonly _schema?: S;
};

export type TypedAccessors<T extends SchemaMap> = {
    [K in keyof T]: EntityAccessor<T[K]>;
};

// --- Proxy query column types ---

import type { ColumnNode } from './proxy-query';

/**
 * ColumnRef is the type exposed to users in proxy query callbacks.
 * `& string` is a brand that lets TS accept column refs as computed property
 * keys in WHERE / orderBy objects, matching the runtime `toString()` behavior.
 */
export type ColumnRef = ColumnNode & string;

/**
 * Full proxy column map for a schema type T.
 * Declared fields get autocomplete; the index signature allows any runtime column
 * (e.g. FK fields like `author_id`) to be accessed without errors.
 */
export type ProxyColumns<T> = Required<{ [K in keyof T]: ColumnRef }> & {
    id: ColumnRef;
    [k: string]: ColumnRef;
};
