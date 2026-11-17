/**
 * database.ts — Main Database class for sqlite-zod-orm
 *
 * Slim orchestrator: initializes the schema, creates tables/triggers,
 * and delegates CRUD, entity augmentation, and query building to
 * focused modules.
 */
import { Database as SqliteDatabase } from "bun:sqlite";
import { createMeasure } from "measure-fn";
import { z } from "zod";
import {
  QueryBuilder,
  executeProxyQuery,
  createQueryBuilder,
  type ProxyQueryResult,
} from "./query";
import type {
  SchemaMap,
  DatabaseOptions,
  TransactionOptions,
  Relationship,
  RelationsConfig,
  EntityAccessor,
  TypedAccessors,
  TypedNavAccessors,
  AugmentedEntity,
  UpdateBuilder,
  ProxyColumns,
  InferSchema,
  ChangeEvent,
  ViewDefinitions,
  ViewDefinition,
  TypedReadonlyAccessors,
} from "./types";
import { asZodObject } from "./types";
import {
  parseRelationsConfig,
  getStorableFields,
  zodTypeToSqlType,
} from "./schema";
import { transformFromStorage, transformForStorage } from "./schema";
import type { DatabaseContext } from "./context";
import {
  upsertOnConflict as nativeUpsertOnConflict,
  insertOnConflictDoNothing,
} from "./conflict";
import { buildWhereClause } from "./helpers";
import { createMigrator, type DatabaseMigrator } from "./migrator";
import { attachMethods } from "./entity";
import {
  insert,
  insertMany,
  update,
  upsert,
  upsertMany,
  findOrCreate,
  deleteEntity,
  createDeleteBuilder,
  getById,
  getOne,
  findMany,
  updateWhere,
  createUpdateBuilder,
} from "./crud";

// =============================================================================
// Database Class
// =============================================================================

type Listener = {
  table: string;
  event: ChangeEvent;
  callback: (row: any) => void | Promise<void>;
};

class _Database<Schemas extends SchemaMap> {
  private db: SqliteDatabase;
  private _reactive: boolean;
  private _timestamps: boolean;
  private _softDeletes: boolean;
  private _debug: boolean;
  private schemas: Schemas;
  private allSchemas: SchemaMap;
  private viewDefinitions: ViewDefinitions;
  private relationships: Relationship[];
  private options: DatabaseOptions<any, any>;

  /** Shared context for extracted modules. */
  private _ctx: DatabaseContext;

  /** Registered change listeners. */
  private _listeners: Listener[] = [];

  /** Watermark: last processed change id from _changes table. */
  private _changeWatermark: number = 0;

  /** Global poll timer (single loop for all listeners). */
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Poll interval in ms. */
  private _pollInterval: number;

  /** Scoped measure-fn instance for instrumentation. */
  private _measure: ReturnType<typeof createMeasure>;

  /** Prepared statement cache — avoids re-compiling identical SQL. */
  private _stmtCache = new Map<string, ReturnType<SqliteDatabase["query"]>>();
  private _schemaRebuildLogs: string[] = [];

  /** Get or create a cached prepared statement. */
  private _stmt(sql: string): ReturnType<SqliteDatabase["query"]> {
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.query(sql);
      this._stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Conditional measurement helper — wraps with measure-fn only when debug is on.
   * When debug is off, executes fn directly with zero overhead.
   */
  private _m<T>(label: string, fn: () => T): T {
    if (!this._debug) return fn();
    // measure-fn 5 rejects potentially Promise-like generic return types.
    // ORM operations here are synchronous; erase T only at the instrumentation
    // boundary and preserve its result type. Without a catch action, sync()
    // rethrows the original callback exception.
    return this._measure.sync<unknown>(label, fn) as T;
  }

  constructor(
    dbFile: string,
    schemas: Schemas,
    options: DatabaseOptions<any, any> = {},
  ) {
    this._debug = options.debug === true;
    this._measure = createMeasure("satidb");

    const busyTimeout = options.busyTimeout ?? 5000;
    if (
      !Number.isInteger(busyTimeout) ||
      busyTimeout < 0 ||
      busyTimeout > 2147483647
    )
      throw new RangeError(
        "busyTimeout must be an integer between 0 and 2147483647 ms",
      );
    this.db = new SqliteDatabase(dbFile);
    try {
      this.db.run(`PRAGMA busy_timeout = ${busyTimeout}`);
      if (options.wal !== false) this.db.run("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.db.close(true);
      throw error;
    }
    this.schemas = schemas;
    this.viewDefinitions = options.views ?? {};
    this.allSchemas = {
      ...this.schemas,
      ...Object.fromEntries(
        Object.entries(this.viewDefinitions).map(([viewName, def]) => [
          viewName,
          def.schema,
        ]),
      ),
    };
    this.options = options;
    this._reactive = options.reactive !== false; // default true
    this._timestamps = options.timestamps === true;
    this._softDeletes = options.softDeletes === true;
    this._pollInterval = options.pollInterval ?? 100;
    try {
      this.relationships = options.relations
        ? parseRelationsConfig(options.relations, this.allSchemas)
        : [];
    } catch (error) {
      this.db.close(true);
      throw error;
    }

    // Build the context that extracted modules use
    this._ctx = {
      db: this.db,
      schemas: this.allSchemas,
      relationships: this.relationships,
      viewNames: new Set(Object.keys(this.viewDefinitions)),
      attachMethods: (name, entity) => attachMethods(this._ctx, name, entity),
      buildWhereClause: (conds, prefix) => buildWhereClause(conds, prefix),
      debug: this._debug,
      timestamps: this._timestamps,
      softDeletes: this._softDeletes,
      hooks: options.hooks ?? {},
      computed: options.computed ?? {},
      cascade: options.cascade ?? {},
      _m: <T>(label: string, fn: () => T): T => this._m(label, fn),
      _stmt: (sql: string) => this._stmt(sql),
    };

    // Foreign keys must be disabled outside the transaction for safe table
    // replacement. Check them before committing, then enable normal enforcement.
    try {
      this.db.run("PRAGMA foreign_keys = OFF");
      this.db
        .transaction(() => {
          this._m("Sync tables", () => this.syncTablesToSchemas());
          if (options.indexes)
            this._m("Create indexes", () =>
              this.createIndexes(options.indexes!),
            );
          if (options.unique)
            this._m("Unique constraints", () =>
              this.createUniqueConstraints(options.unique!),
            );
          if (options.views)
            this._m("Create views", () =>
              this.createOrUpdateViews(options.views!),
            );
          if (this._reactive)
            this._m("Change tracking", () => this.initializeChangeTracking());
          if (this._schemaRebuildLogs.length) {
            const violations = this.db.query("PRAGMA foreign_key_check").all();
            if (violations.length)
              throw new Error("Schema sync would leave foreign key violations");
            // Views are stored as SQL text. Check dependent view resolution
            // before the transaction commits, rather than leaving broken views.
            const views = this.db.query(
              "SELECT name FROM sqlite_master WHERE type = 'view'",
            ).all() as { name: string }[];
            for (const view of views) {
              this.db.query(`SELECT * FROM "${this.escapeIdentifier(view.name)}" LIMIT 0`).all();
            }
            // Preparing EXPLAIN compiles trigger bodies, including triggers on
            // unrelated tables and INSTEAD OF triggers on views, without DML.
            this.validateTriggers();
          }
        })
        .immediate();
      this.db.run("PRAGMA foreign_keys = ON");
    } catch (error) {
      this.db.close(true);
      throw error;
    }
    for (const message of this._schemaRebuildLogs) console.warn(message);
    this._schemaRebuildLogs = [];

    // Create typed entity accessors (db.users, db.posts, etc.)
    for (const entityName of Object.keys(schemas)) {
      const key = entityName as keyof Schemas;
      const accessor: EntityAccessor<Schemas[typeof key]> = {
        get: (id: number) =>
          this._m(`${entityName}.get`, () =>
            getById(this._ctx, entityName, id),
          ),
        insert: (data) =>
          this._m(`${entityName}.insert`, () =>
            insert(this._ctx, entityName, data),
          ),
        insertMany: (rows: any[]) =>
          this._m(`${entityName}.insertMany(${rows.length})`, () =>
            insertMany(this._ctx, entityName, rows),
          ),
        update: (idOrData: any, data?: any) => {
          if (typeof idOrData === "number")
            return this._m(`${entityName}.update(${idOrData})`, () =>
              update(this._ctx, entityName, idOrData, data),
            );
          return createUpdateBuilder(this._ctx, entityName, idOrData);
        },
        upsert: ((first: any, second?: any) =>
          this._m(`${entityName}.upsert`, () => {
            if (second && typeof second === "object" && "on" in second) {
              if (second.doNothing === true) {
                const entity = insertOnConflictDoNothing(
                  this._ctx,
                  entityName,
                  first,
                  second.on,
                );
                if (!entity)
                  throw new Error(
                    `Failed to retrieve entity after ${entityName}.upsert(..., { doNothing: true })`,
                  );
                return entity;
              }
              if (typeof second.merge !== "function") {
                throw new Error(
                  `${entityName}.upsert(row, { on, merge }) requires a merge function unless doNothing is true.`,
                );
              }
              return nativeUpsertOnConflict(
                this._ctx,
                entityName,
                first,
                second.on,
                second.merge,
              );
            }
            return upsert(this._ctx, entityName, second, first);
          })) as any,
        upsertOnConflict: (data: any, target: any, merge: any) =>
          this._m(`${entityName}.upsertOnConflict`, () =>
            nativeUpsertOnConflict(this._ctx, entityName, data, target, merge),
          ),
        upsertMany: (rows: any[], conditions?: any) =>
          this._m(`${entityName}.upsertMany(${rows.length})`, () =>
            upsertMany(this._ctx, entityName, rows, conditions),
          ),
        findOrCreate: (conditions: any, defaults?: any) =>
          this._m(`${entityName}.findOrCreate`, () =>
            findOrCreate(this._ctx, entityName, conditions, defaults),
          ),
        delete: ((id?: any) => {
          if (typeof id === "number") {
            return this._m(`${entityName}.delete(${id})`, () => {
              // beforeDelete hook — return false to cancel
              const hooks = this._ctx.hooks[entityName];
              if (hooks?.beforeDelete) {
                const result = hooks.beforeDelete(id);
                if (result === false) return;
              }

              // Cascade delete children first
              const cascadeTargets = this._ctx.cascade[entityName];
              if (cascadeTargets) {
                for (const childTable of cascadeTargets) {
                  const rels = this._ctx.relationships.filter(
                    (r) => r.type === "belongs-to" &&
                      r.from === childTable && r.to === entityName,
                  );
                  if (rels.length) {
                    // A child can reference this parent through more than one FK.
                    const clause = rels.map((r) =>
                      `"${this.escapeIdentifier(r.foreignKey)}" = ?`,
                    ).join(" OR ");
                    const params = rels.map(() => id);
                    const child = this.escapeIdentifier(childTable);
                    if (this._softDeletes) {
                      const now = new Date().toISOString();
                      this._stmt(
                        `UPDATE "${child}" SET "deletedAt" = ? WHERE ${clause}`,
                      ).run(now, ...params);
                    } else {
                      this._stmt(`DELETE FROM "${child}" WHERE ${clause}`)
                        .run(...params);
                    }
                  }
                }
              }

              if (this._softDeletes) {
                const now = new Date().toISOString();
                this._stmt(
                  `UPDATE "${entityName}" SET "deletedAt" = ? WHERE id = ?`,
                ).run(now, id);
                if (hooks?.afterDelete) hooks.afterDelete(id);
                return;
              }
              return deleteEntity(this._ctx, entityName, id);
            });
          }
          return createDeleteBuilder(this._ctx, entityName);
        }) as any,
        restore: ((id: number) => {
          if (!this._softDeletes)
            throw new Error("restore() requires softDeletes: true");
          this._m(`${entityName}.restore(${id})`, () => {
            this._stmt(
              `UPDATE "${entityName}" SET "deletedAt" = NULL WHERE id = ?`,
            ).run(id);
          });
        }) as any,
        select: (...cols: string[]) =>
          createQueryBuilder(this._ctx, entityName, cols),
        count: () =>
          this._m(`${entityName}.count`, () => {
            const row = this._stmt(
              `SELECT COUNT(*) as count FROM "${entityName}"${this._softDeletes ? ' WHERE "deletedAt" IS NULL' : ""}`,
            ).get() as any;
            return row?.count ?? 0;
          }),
        on: (
          event: ChangeEvent,
          callback: (row: any) => void | Promise<void>,
        ) => {
          return this._registerListener(entityName, event, callback);
        },
        _tableName: entityName,
      };
      (this as any)[key] = accessor;
    }

    for (const [viewName, def] of Object.entries(this.viewDefinitions)) {
      const key = viewName as keyof typeof this.viewDefinitions;
      (this as any)[key] = this.createReadonlyAccessor(viewName, def);
    }
  }

  // =========================================================================
  // Table Initialization & Migrations
  // =========================================================================

  private syncTablesToSchemas(): void {
    // Compare structure rather than CREATE TABLE formatting/column order.
    for (const [entityName, schema] of Object.entries(this.schemas)) {
      const expectedSql = this.createTableSql(entityName, schema);
      const existing = this.db
        .query(
          `SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`,
        )
        .get(entityName) as { type?: string; sql?: string | null } | null;

      if (!existing) {
        this.db.run(expectedSql);
        continue;
      }

      if (existing.type !== "table") {
        throw new Error(`"${entityName}" already exists and is not a table.`);
      }

      if (
        this.normalizeSql(existing.sql ?? "") !== this.normalizeSql(expectedSql)
      ) {
        this.syncExistingTable(entityName, schema);
        continue;
      }
    }
  }

  private syncExistingTable(entityName: string, schema: z.ZodType<any>): void {
    // Schema changes always reconstruct the table, including additive changes.
    // A snapshot and replacement keep schema objects attached to the live name.
    this.backupAndRecreateTable(entityName, schema);
  }

  private sqlLiteral(value: any): string {
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    if (value instanceof Buffer) return `X'${value.toString("hex")}'`;
    throw new Error("Unsupported SQLite column default");
  }

  private createTableSql(entityName: string, schema: z.ZodType<any>): string {
    const storableFields = getStorableFields(schema);
    const columnDefs = storableFields.map(
      (f) => `"${f.name}" ${zodTypeToSqlType(f.type)}`,
    );

    // Add timestamp columns
    if (this._timestamps) {
      columnDefs.push('"createdAt" TEXT');
      columnDefs.push('"updatedAt" TEXT');
    }
    // Add soft delete column
    if (this._softDeletes) {
      columnDefs.push('"deletedAt" TEXT');
    }

    const constraints: string[] = [];

    const belongsToRels = this.relationships.filter(
      (rel) => rel.type === "belongs-to" && rel.from === entityName,
    );
    for (const rel of belongsToRels) {
      constraints.push(
        `FOREIGN KEY ("${rel.foreignKey}") REFERENCES "${rel.to}"(id) ON DELETE SET NULL`,
      );
    }

    const body = [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      ...columnDefs,
      ...constraints,
    ].join(", ");
    return `CREATE TABLE "${entityName}" (${body})`;
  }

  /** Refuse implicit migrations that would lose values or SQLite semantics. */
  private assertSafeRebuild(entityName: string, schema: z.ZodType<any>): void {
    const q = (name: string) => `"${this.escapeIdentifier(name)}"`;
    const columns = this.db.query(`PRAGMA table_info(${q(entityName)})`).all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const expected = new Map<string, string>([
      ["id", "INTEGER"],
      ...getStorableFields(schema).map((field) =>
        [field.name, zodTypeToSqlType(field.type)] as [string, string]),
      ...(this._timestamps ? [["createdAt", "TEXT"], ["updatedAt", "TEXT"]] as [string, string][] : []),
      ...(this._softDeletes ? [["deletedAt", "TEXT"]] as [string, string][] : []),
    ]);
    const oldNames = new Set(columns.map((column) => column.name));
    const additions = [...expected.keys()].filter((name) => !oldNames.has(name));
    const populated = (name: string) => !!this.db.query(
      `SELECT 1 FROM ${q(entityName)} WHERE ${q(name)} IS NOT NULL LIMIT 1`,
    ).get();

    for (const column of columns) {
      const nextType = expected.get(column.name);
      if (nextType && column.type.trim().toUpperCase() !== nextType && populated(column.name)) {
        throw new Error(
          `Cannot automatically change type of populated column "${entityName}.${column.name}" ` +
          `from ${column.type} to ${nextType}; use an explicit data-conversion migration.`,
        );
      }
    }
    if (additions.length) {
      const removed = columns.find((column) =>
        !expected.has(column.name) && populated(column.name));
      if (removed) {
        throw new Error(
          `Cannot automatically drop populated column "${entityName}.${removed.name}" ` +
          `while adding ${additions.map(q).join(", ")}; use an explicit column-mapping migration.`,
        );
      }
    }

    // The generated DDL contains no CHECK, NOT NULL or conflict-resolution
    // clauses. Strip literals, quoted identifiers and comments so words inside
    // user data/column names are not mistaken for constraints.
    const ddl = this.db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(entityName) as { sql: string } | null;
    if (!ddl) throw new Error(`Cannot inspect table "${entityName}" before rebuild.`);
    const clauses = ddl.sql.replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g,
      " ",
    );
    const unsupported = /\bCHECK\s*\(/i.test(clauses) ? "CHECK" :
      /\bON\s+CONFLICT\b/i.test(clauses) ? "ON CONFLICT" :
      (columns.some((column) => column.notnull) || /\bNOT\s+NULL\b/i.test(clauses))
        ? "NOT NULL" : null;
    if (unsupported) {
      throw new Error(
        `Cannot automatically rebuild "${entityName}": legacy ${unsupported} ` +
        `constraint/policy cannot be recreated; use an explicit constraint-preserving migration.`,
      );
    }

    // Check every outgoing FK, including target columns, composite FKs and
    // actions. foreign_key_check tests data only, not changed delete behavior.
    type ForeignKey = {
      id: number; seq: number; table: string; from: string; to: string | null;
      on_delete: string; on_update: string;
    };
    const existing = this.db.query(`PRAGMA foreign_key_list(${q(entityName)})`).all() as ForeignKey[];
    const recreated = this.relationships
      .filter((relation) => relation.type === "belongs-to" && relation.from === entityName)
      .map((relation) => ({
        seq: 0, table: relation.to, from: relation.foreignKey, to: "id",
        on_delete: "SET NULL", on_update: "NO ACTION",
      }));
    const identity = (fk: Omit<ForeignKey, "id">) => [
      fk.seq, fk.table.toLowerCase(), fk.from.toLowerCase(),
      (fk.to ?? "").toLowerCase(), fk.on_delete.toUpperCase(), fk.on_update.toUpperCase(),
    ].join("|");
    const actualKeys = existing.map(identity).sort();
    const expectedKeys = recreated.map(identity).sort();
    if (actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error(
        `Cannot automatically rebuild "${entityName}": outgoing foreign keys ` +
        `(targets or ON DELETE/ON UPDATE actions) differ; use an explicit foreign-key migration.`,
      );
    }
  }

  private backupAndRecreateTable(
    entityName: string,
    schema: z.ZodType<any>,
  ): void {
    this.assertSafeRebuild(entityName, schema);
    const backupName = this.nextBackupTableName(entityName);

    const q = (name: string) => `"${this.escapeIdentifier(name)}"`;
    const objects = this.db
      .query(
        "SELECT name, type, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger')",
      )
      .all(entityName) as { name: string; type: string; sql: string | null }[];
    // SQLite autoindexes for inline UNIQUE constraints have null sqlite_master.sql.
    // Reconstitute those constraints as named unique indexes on the replacement.
    const inlineIndexes = (
      this.db.query(`PRAGMA index_list(${q(entityName)})`).all() as {
        name: string;
        origin: string;
        unique: number;
      }[]
    ).filter((index) => index.origin === "u");
    const restoredUnique = inlineIndexes.map((index, offset) => {
      const fields = this.db.query(`PRAGMA index_xinfo(${q(index.name)})`).all() as {
        cid: number;
        name: string | null;
        coll: string;
        desc: number;
        key: number;
      }[];
      const keys = fields.filter((column) => column.key === 1);
      if (keys.length === 0 || keys.some((column) => column.cid < 0 || !column.name)) {
        throw new Error(`Cannot automatically reconstruct inline index '${index.name}'.`);
      }
      const name = `uq_rebuilt_${entityName}_${offset + 1}`;
      if (this.objectExists(name) && !objects.some((object) => object.name === name)) {
        throw new Error(`Rebuild index '${name}' conflicts with an existing schema object.`);
      }
      const sql = `CREATE UNIQUE INDEX ${q(name)} ON ${q(entityName)} (` +
        keys.map((column) => `${q(column.name!)} COLLATE ${q(column.coll)}${column.desc ? " DESC" : ""}`).join(", ") +
        ")";
      return { name, sql };
    });
    if (objects.some((object) => object.sql === null && !inlineIndexes.some((index) => index.name === object.name))) {
      throw new Error(`Cannot reconstruct an unnamed index on '${entityName}'.`);
    }
    const oldColumns = new Set(
      (
        this.db.query(`PRAGMA table_info(${q(entityName)})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    const sequence = this.objectExists("sqlite_sequence")
      ? (this.db
          .query("SELECT seq FROM sqlite_sequence WHERE name = ?")
          .get(entityName) as { seq: number } | null)
      : null;
    const txn = this.db.transaction(() => {
      // Snapshot first, then replace using the original name. Renaming the old
      // table would redirect foreign keys, views and application trigger bodies.
      this.db.run(
        `CREATE TABLE ${q(backupName)} AS SELECT * FROM ${q(entityName)}`,
      );
      this.db.run(`DROP TABLE ${q(entityName)}`);
      this.db.run(this.createTableSql(entityName, schema));
      const columns = (
        this.db.query(`PRAGMA table_info(${q(entityName)})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      const expressions = columns.map((name) => {
        if (oldColumns.has(name)) return q(name);
        const field = getStorableFields(schema).find((f) => f.name === name);
        const parsed = field?.type.safeParse(undefined);
        if (
          !parsed?.success &&
          field &&
          !field.type.isNullable() &&
          this.db.query(`SELECT 1 FROM ${q(backupName)} LIMIT 1`).get()
        ) {
          throw new Error(
            `Cannot populate required column "${entityName}.${name}"; add a default or use an explicit migration.`,
          );
        }
        if (
          !parsed?.success ||
          parsed.data === undefined ||
          parsed.data === null
        )
          return "NULL";
        return this.sqlLiteral(
          transformForStorage({ value: parsed.data }).value,
        );
      });
      this.db.run(
        `INSERT INTO ${q(entityName)} (${columns.map(q).join(", ")}) SELECT ${expressions.join(", ")} FROM ${q(backupName)}`,
      );
      if (sequence)
        this.db
          .query("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?")
          .run(sequence.seq, entityName);
      for (const object of objects) if (object.sql) this.db.run(object.sql);
      for (const index of restoredUnique) this.db.run(index.sql);
    });
    txn();
    this._schemaRebuildLogs.push(
      `[sqlite-zod-orm] Rebuilt "${entityName}" from "${backupName}"; preserved ids, copied shared columns, and restored ${objects.filter((object) => object.sql).length + restoredUnique.length} indexes/triggers.`,
    );
  }

  /** Prepare and step an EXPLAIN without caching it, then finalize it, so no
   *  statement is left in progress when the savepoint or transaction ends. */
  private compileOnly(sql: string): void {
    const stmt = this.db.prepare(sql);
    try {
      stmt.all();
    } finally {
      stmt.finalize();
    }
  }

  /** Check all schema triggers after a rebuild, before the outer commit. */
  private validateTriggers(): void {
    type Event = "INSERT" | "UPDATE" | "DELETE";
    type Trigger = { name: string; tbl_name: string; sql: string };
    const triggers = this.db.query(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all() as Trigger[];
    const q = (name: string) => `"${this.escapeIdentifier(name)}"`;
    const rowidTables = new Set(
      (this.db.query("PRAGMA table_list").all() as {
        schema: string; name: string; type: string; wr: number;
      }[]).filter((table) => table.schema === "main" && table.type === "table" && !table.wr)
        .map((table) => table.name.toLowerCase()),
    );
    const checks: { trigger: Trigger; event: Event; explain: string }[] = [];

    for (const trigger of triggers) {
      // Tokenize the CREATE TRIGGER header so quoted names and comments cannot
      // be mistaken for the event keyword (SQLite has no trigger-list PRAGMA).
      const tokens = (trigger.sql.match(
        /--[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|'(?:[^']|'')*'|[A-Za-z_][\w$]*|[^\s]/g,
      ) ?? []).filter(
        (token) => !token.startsWith("--") && !token.startsWith("/*"),
      );
      const word = (index: number) => tokens[index]?.toUpperCase();
      let i = 0;
      if (word(i++) !== "CREATE")
        throw new Error(`Invalid trigger definition: ${trigger.name}`);
      if (word(i) === "TEMP" || word(i) === "TEMPORARY") i++;
      if (word(i++) !== "TRIGGER")
        throw new Error(`Invalid trigger definition: ${trigger.name}`);
      if (word(i) === "IF") i += 3; // IF NOT EXISTS
      i++; // trigger identifier
      if (tokens[i] === ".") i += 2; // optional schema qualifier
      if (word(i) === "BEFORE" || word(i) === "AFTER") i++;
      else if (word(i) === "INSTEAD" && word(i + 1) === "OF") i += 2;
      const event = word(i) as Event;
      if (event !== "INSERT" && event !== "UPDATE" && event !== "DELETE")
        throw new Error(`Cannot determine event for trigger "${trigger.name}"`);

      const columns = this.db
        .query(`PRAGMA table_xinfo(${q(trigger.tbl_name)})`)
        .all() as { name: string; hidden: number }[];
      const writable = columns.filter((col) => col.hidden === 0).map((col) => col.name);
      // UPDATE OF rowid/oid/_rowid_ is valid on ordinary rowid tables.
      if (rowidTables.has(trigger.tbl_name.toLowerCase())) {
        for (const alias of ["rowid", "oid", "_rowid_"]) {
          if (!writable.some((name) => name.toLowerCase() === alias))
            writable.push(alias);
        }
      }
      if (event === "UPDATE" && word(i + 1) === "OF") {
        const known = new Set(writable.map((name) => name.toLowerCase()));
        for (let j = i + 2; j < tokens.length && word(j) !== "ON"; j++) {
          if (tokens[j] === ",") continue;
          const token = tokens[j]!;
          const column = token.startsWith('"') || token.startsWith("`")
            ? token.slice(1, -1).replaceAll(token[0]! + token[0]!, token[0]!)
            : token.startsWith("[")
              ? token.slice(1, -1)
              : token;
          if (!known.has(column.toLowerCase()))
            throw new Error(
              `Invalid trigger "${trigger.name}": no such column: ${column}`,
            );
        }
      }

      const table = q(trigger.tbl_name);
      const explain =
        event === "INSERT"
          ? `EXPLAIN INSERT INTO ${table} DEFAULT VALUES`
          : event === "DELETE"
            ? `EXPLAIN DELETE FROM ${table} WHERE 0`
            : `EXPLAIN UPDATE ${table} SET ${writable
                .map((name) => `${q(name)} = ${q(name)}`)
                .join(", ")} WHERE 0`;
      checks.push({ trigger, event, explain });
    }

    // One EXPLAIN per table/event normally compiles all relevant triggers.
    const checked = new Set<string>();
    for (const check of checks) {
      const key = `${check.trigger.tbl_name.toLowerCase()}\0${check.event}`;
      if (checked.has(key)) continue;
      try {
        this.compileOnly(check.explain);
      } catch (error) {
        // EXPLAIN also compiles nested triggers, so its error alone cannot
        // identify the broken one. Temporarily isolate each trigger under a
        // savepoint; restoring the savepoint leaves the schema untouched.
        for (const candidate of checks) {
          this.db.run("SAVEPOINT orm_trigger_check");
          let failure: unknown;
          try {
            for (const other of checks) {
              if (other !== candidate)
                this.db.run(`DROP TRIGGER ${q(other.trigger.name)}`);
            }
            this.compileOnly(candidate.explain);
          } catch (cause) {
            failure = cause;
          } finally {
            this.db.run("ROLLBACK TO orm_trigger_check");
            this.db.run("RELEASE orm_trigger_check");
          }
          if (failure) {
            throw new Error(
              `Invalid trigger "${candidate.trigger.name}": ${String(failure)}`,
              { cause: failure },
            );
          }
        }
        throw new Error(`Trigger validation failed: ${String(error)}`, {
          cause: error,
        });
      }
      checked.add(key);
    }
  }

  private nextBackupTableName(tableName: string): string {
    let version = 1;
    while (this.objectExists(`${tableName}_v${version}`)) {
      version++;
    }
    return `${tableName}_v${version}`;
  }

  private objectExists(name: string): boolean {
    const row = this.db
      .query(`SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1`)
      .get(name) as any;
    return !!row;
  }

  private escapeIdentifier(value: string): string {
    return value.replace(/"/g, '""');
  }

  /**
   * Initialize per-table change tracking using triggers.
   *
   * Creates a `_changes` table that logs every insert/update/delete with
   * the table name, operation, and affected row id. This enables
   * row-level change detection for the `on()` API.
   */
  private initializeChangeTracking(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS "_changes" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tbl TEXT NOT NULL,
            op TEXT NOT NULL,
            row_id INTEGER NOT NULL
        )`);

    for (const entityName of Object.keys(this.schemas)) {
      // INSERT trigger — logs NEW.id
      this.db.run(`CREATE TRIGGER IF NOT EXISTS "_trg_${entityName}_insert"
                AFTER INSERT ON "${entityName}"
                BEGIN
                    INSERT INTO "_changes" (tbl, op, row_id) VALUES ('${entityName}', 'insert', NEW.id);
                END`);

      // UPDATE trigger — logs NEW.id (post-update row)
      this.db.run(`CREATE TRIGGER IF NOT EXISTS "_trg_${entityName}_update"
                AFTER UPDATE ON "${entityName}"
                BEGIN
                    INSERT INTO "_changes" (tbl, op, row_id) VALUES ('${entityName}', 'update', NEW.id);
                END`);

      // DELETE trigger — logs OLD.id (row that was deleted)
      this.db.run(`CREATE TRIGGER IF NOT EXISTS "_trg_${entityName}_delete"
                AFTER DELETE ON "${entityName}"
                BEGIN
                    INSERT INTO "_changes" (tbl, op, row_id) VALUES ('${entityName}', 'delete', OLD.id);
                END`);
    }

    // Initialize watermark to current max (skip replaying historical changes)
    const row = this.db
      .query('SELECT MAX(id) as maxId FROM "_changes"')
      .get() as any;
    this._changeWatermark = row?.maxId ?? 0;
  }

  private createIndexes(indexes: Record<string, (string | string[])[]>): void {
    for (const [tableName, indexDefs] of Object.entries(indexes)) {
      for (const def of indexDefs) {
        const cols = Array.isArray(def) ? def : [def];
        const idxName = `idx_${tableName}_${cols.join("_")}`;
        this.db.run(
          `CREATE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")})`,
        );
      }
    }
  }

  private createUniqueConstraints(unique: Record<string, string[][]>): void {
    for (const [tableName, groups] of Object.entries(unique)) {
      for (const cols of groups) {
        const idxName = `uq_${tableName}_${cols.join("_")}`;
        this.db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")})`,
        );
      }
    }
  }

  private createOrUpdateViews(views: ViewDefinitions): void {
    for (const [viewName, def] of Object.entries(views)) {
      const selectSql = this.normalizeViewSelect(def.as);
      const createSql = `CREATE VIEW "${viewName}" AS ${selectSql}`;
      const existing = this.db
        .query("SELECT type, sql FROM sqlite_master WHERE name = ?")
        .get(viewName) as { type?: string; sql?: string | null } | null;

      if (!existing) {
        this.db.run(createSql);
        continue;
      }

      if (existing.type !== "view") {
        throw new Error(`"${viewName}" already exists and is not a view.`);
      }

      if (
        this.normalizeSql(existing.sql ?? "") !== this.normalizeSql(createSql)
      ) {
        this.db.run(`DROP VIEW IF EXISTS "${viewName}"`);
        this.db.run(createSql);
      }
    }
  }

  private createReadonlyAccessor(
    viewName: string,
    _def: ViewDefinition,
  ): Record<string, any> {
    const readonlyError = () => {
      throw new Error(`"${viewName}" is a read-only view.`);
    };

    return {
      insert: readonlyError,
      insertMany: readonlyError,
      update: readonlyError,
      upsert: readonlyError,
      upsertMany: readonlyError,
      findOrCreate: readonlyError,
      delete: readonlyError,
      restore: readonlyError,
      select: (...cols: string[]) =>
        createQueryBuilder(this._ctx, viewName, cols),
      count: () =>
        this._m(`${viewName}.count`, () => {
          const row = this._stmt(
            `SELECT COUNT(*) as count FROM "${viewName}"`,
          ).get() as any;
          return row?.count ?? 0;
        }),
      on: readonlyError,
      _tableName: viewName,
      _isView: true,
    };
  }

  private normalizeViewSelect(sql: string): string {
    return sql.trim().replace(/;+\s*$/, "");
  }

  private normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().toLowerCase();
  }

  // =========================================================================
  // Change Listeners — db.table.on('insert' | 'update' | 'delete', cb)
  // =========================================================================

  private _registerListener(
    table: string,
    event: ChangeEvent,
    callback: (row: any) => void | Promise<void>,
  ): () => void {
    if (!this._reactive) {
      throw new Error(
        "Change listeners are disabled. Set { reactive: true } (or omit it) in Database options to enable .on().",
      );
    }

    const listener: Listener = { table, event, callback };
    this._listeners.push(listener);
    this._startPolling();

    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
      if (this._listeners.length === 0) this._stopPolling();
    };
  }

  private _startPolling(): void {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(
      () => this._processChanges(),
      this._pollInterval,
    );
  }

  /** Run one listener; a throw or a rejected promise never stops dispatch. */
  private _callListener(listener: Listener, payload: unknown): void {
    try {
      const result = (listener.callback as (row: unknown) => unknown)(payload);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        Promise.resolve(result).catch((error) => {
          console.error(`[sqlite-zod-orm] ${listener.table}.on("${listener.event}") listener failed:`, error);
        });
      }
    } catch (error) {
      console.error(`[sqlite-zod-orm] ${listener.table}.on("${listener.event}") listener failed:`, error);
    }
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Core change dispatch loop.
   *
   * Fast path: checks MAX(id) against watermark first — if equal,
   * there are no new changes and we skip entirely (no row materialization).
   * Only fetches actual change rows when something has changed.
   */
  private _processChanges(): void {
    // Fast path: check if anything changed at all (single scalar, index-only)
    const head = this._stmt('SELECT MAX(id) as m FROM "_changes"').get() as any;
    const maxId: number = head?.m ?? 0;
    if (maxId <= this._changeWatermark) return;

    const changes = this._stmt(
      'SELECT id, tbl, op, row_id FROM "_changes" WHERE id > ? ORDER BY id',
    ).all(this._changeWatermark) as {
      id: number;
      tbl: string;
      op: string;
      row_id: number;
    }[];

    for (const change of changes) {
      const listeners = this._listeners.filter(
        (l) => l.table === change.tbl && l.event === change.op,
      );

      if (listeners.length > 0) {
        const payload =
          change.op === "delete"
            ? { id: change.row_id } // the row is gone: pass just the id
            : getById(this._ctx, change.tbl, change.row_id); // re-fetch the current row
        if (payload) {
          for (const l of listeners) {
            // A listener removed by an earlier listener in this dispatch is skipped.
            if (!this._listeners.includes(l)) continue;
            this._callListener(l, payload);
          }
        }
      }

      this._changeWatermark = change.id;
    }

    // Clean up consumed changes
    this._stmt('DELETE FROM "_changes" WHERE id <= ?').run(
      this._changeWatermark,
    );
  }

  // =========================================================================
  // Transactions
  // =========================================================================

  public transaction<T>(
    callback: () => T,
    options: TransactionOptions = {},
  ): T {
    return this._m("transaction", () =>
      this.db.transaction(() => {
        const result = callback();
        // SQLite commits when the callback returns, not when a Promise
        // settles: awaited writes would run outside the transaction. Throwing
        // here rolls the transaction back.
        if (result && typeof (result as any).then === "function") {
          void Promise.resolve(result).catch(() => undefined);
          throw new TypeError(
            "db.transaction() callback must be synchronous; do async work before or after the transaction",
          );
        }
        return result;
      })[options.mode ?? "immediate"](),
    );
  }

  /** Close the database: stops polling, clears cache, and releases the SQLite handle. */
  public close(): void {
    this._stopPolling();
    for (const stmt of this._stmtCache.values()) stmt.finalize();
    this._stmtCache.clear();
    this.db.close(true);
  }

  // =========================================================================
  // Proxy Query
  // =========================================================================

  /** Proxy callback query for complex SQL-like JOINs */
  public query<T extends Record<string, any> = Record<string, any>>(
    callback: (ctx: {
      [K in keyof Schemas]: ProxyColumns<InferSchema<Schemas[K]>>;
    }) => ProxyQueryResult,
  ): T[] {
    return this._m("query(proxy)", () =>
      executeProxyQuery(
        this.schemas,
        callback as any,
        (sql: string, params: any[]) => {
          return this._stmt(sql).all(...params) as T[];
        },
      ),
    );
  }

  // =========================================================================
  // Backup Table Data Migration
  // =========================================================================

  /**
   * Create a data migrator for copying rows from schema-sync backup tables
   * such as users_v1 into the current users table. Backup tables are never
   * removed automatically.
   */
  public migrator(): DatabaseMigrator {
    return createMigrator(this);
  }

  // =========================================================================
  // Raw SQL
  // =========================================================================

  /** Execute a raw SQL query and return results. */
  public raw<T = any>(sql: string, ...params: any[]): T[] {
    return this._m(
      `raw: ${sql.slice(0, 60)}`,
      () => this._stmt(sql).all(...params) as T[],
    );
  }

  /** Execute a raw SQL statement (INSERT/UPDATE/DELETE) without returning rows. */
  public exec(sql: string, ...params: any[]): void {
    this._m(`exec: ${sql.slice(0, 60)}`, () => this.db.run(sql, ...params));
  }

  // =========================================================================
  // Schema Introspection
  // =========================================================================

  /** Return the list of user-defined table names. */
  public tables(): string[] {
    return Object.keys(this.schemas);
  }

  /** Return the list of registered view names. */
  public views(): string[] {
    return Object.keys(this.viewDefinitions);
  }

  /** Return column info for a table via PRAGMA table_info. */
  public columns(tableName: string): {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[] {
    return this.db.query(`PRAGMA table_info("${tableName}")`).all() as any[];
  }

  // =========================================================================
  // Data Import / Export
  // =========================================================================

  /**
   * Export all data as a JSON-serializable object.
   * Each key is a table name, value is an array of raw row objects.
   */
  public dump(): Record<string, any[]> {
    return this._m("dump", () => {
      const result: Record<string, any[]> = {};
      for (const tableName of Object.keys(this.schemas)) {
        result[tableName] = this.db.query(`SELECT * FROM "${tableName}"`).all();
      }
      return result;
    });
  }

  /**
   * Import data from a dump object. Truncates existing data first.
   * Use `{ append: true }` to insert without truncating.
   */
  public load(
    data: Record<string, any[]>,
    options?: { append?: boolean },
  ): void {
    this._m(`load(${Object.keys(data).join(",")})`, () => {
      const txn = this.db.transaction(() => {
        for (const [tableName, rows] of Object.entries(data)) {
          if (!this.schemas[tableName]) continue;
          if (!options?.append) {
            this.db.run(`DELETE FROM "${tableName}"`);
          }
          for (const row of rows) {
            const cols = Object.keys(row).filter((k) => k !== "id");
            const placeholders = cols.map(() => "?").join(", ");
            const values = cols.map((c) => {
              const v = row[c];
              if (
                v !== null &&
                v !== undefined &&
                typeof v === "object" &&
                !(v instanceof Buffer)
              ) {
                return JSON.stringify(v);
              }
              return v;
            });
            this.db
              .query(
                `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
              )
              .run(...values);
          }
        }
      });
      txn();
    });
  }

  /**
   * Seed tables with fixture data. Each key is a table name, value is an
   * array of records to insert. Does NOT truncate — use for additive seeding.
   */
  public seed(fixtures: Record<string, Record<string, any>[]>): void {
    this.load(fixtures, { append: true });
  }

  // =========================================================================
  // Schema Diffing
  // =========================================================================

  /**
   * Compare Zod schemas against the live SQLite table structure.
   * Returns a diff object per table: { added, removed, typeChanged }.
   */
  public diff(): Record<
    string,
    {
      added: string[];
      removed: string[];
      typeChanged: { column: string; expected: string; actual: string }[];
    }
  > {
    return this._m("diff", () => {
      const result: Record<
        string,
        {
          added: string[];
          removed: string[];
          typeChanged: { column: string; expected: string; actual: string }[];
        }
      > = {};
      const systemCols = new Set(["id", "createdAt", "updatedAt", "deletedAt"]);

      for (const [tableName, schema] of Object.entries(this.schemas)) {
        const schemaFields = getStorableFields(schema);
        const schemaColMap = new Map(
          schemaFields.map((f) => [f.name, zodTypeToSqlType(f.type)]),
        );

        const liveColumns = this.columns(tableName);
        const liveColMap = new Map(liveColumns.map((c) => [c.name, c.type]));

        const added: string[] = [];
        const removed: string[] = [];
        const typeChanged: {
          column: string;
          expected: string;
          actual: string;
        }[] = [];

        for (const [col, expectedType] of schemaColMap) {
          if (!liveColMap.has(col)) {
            added.push(col);
          } else {
            const actualType = liveColMap.get(col)!;
            if (actualType !== expectedType) {
              typeChanged.push({
                column: col,
                expected: expectedType,
                actual: actualType,
              });
            }
          }
        }

        for (const col of liveColMap.keys()) {
          if (!systemCols.has(col) && !schemaColMap.has(col)) {
            removed.push(col);
          }
        }

        if (added.length > 0 || removed.length > 0 || typeChanged.length > 0) {
          result[tableName] = { added, removed, typeChanged };
        }
      }

      return result;
    });
  }
}

// =============================================================================
// Public Export
// =============================================================================

type ViewSchemas<V extends ViewDefinitions> = {
  [K in keyof V]: V[K] extends ViewDefinition<infer T> ? T : never;
};

type Database<
  S extends SchemaMap,
  R extends RelationsConfig = {},
  V extends ViewDefinitions = {},
> = _Database<S> &
  TypedNavAccessors<S, R> &
  TypedReadonlyAccessors<ViewSchemas<V>>;

const Database = _Database as unknown as new <
  S extends SchemaMap,
  const R extends RelationsConfig = {},
  const V extends ViewDefinitions = {},
>(
  dbFile: string,
  schemas: S,
  options?: DatabaseOptions<R, V>,
) => Database<S, R, V>;

export { Database };
export type { Database as DatabaseType };
