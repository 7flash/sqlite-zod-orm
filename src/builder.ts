/**
 * builder.ts — Fluent QueryBuilder class
 *
 * Accumulates query state via chaining and executes when a
 * terminal method (.all(), .get(), .count()) is called.
 */

import {
  type ASTNode,
  type WhereCallback,
  type TypedColumnProxy,
  type FunctionProxy,
  type Operators,
  createColumnProxy,
  createFunctionProxy,
  op,
} from "./ast";
import {
  type IQO,
  type WhereCondition,
  type WhereOperator,
  type OrderDirection,
  OPERATOR_MAP,
  compileIQO, quoteIdentifierPath,
} from "./iqo";
import type {
  SchemaMap, RelationsConfig, EagerWith, WhereInput, StoredColumns, RawRow, RawValue,
} from "./types";

/**
 * Columns a string-based join() appends, named `<table>_<column>` as the SQL
 * aliases them, typed from the joined table's schema (stored, raw values).
 */
type JoinedColumns<S extends SchemaMap, J extends string, C extends string> = {
  [K in C as `${J}_${K}`]: J extends keyof S
    ? S[J] extends { _output: infer Out }
      ? K extends keyof Out ? RawValue<Out[K]> : unknown
      : unknown
    : unknown;
};

/**
 * HAVING compiles a restricted operator subset; IN/BETWEEN/LIKE are
 * deliberately not allowed by compileIQO's HAVING compiler.
 */
type HavingScalar = string | number | boolean | bigint | null | Date | Uint8Array;
type HavingOperators = {
  $gt?: HavingScalar;
  $gte?: HavingScalar;
  $lt?: HavingScalar;
  $lte?: HavingScalar;
  $ne?: HavingScalar;
  $isNull?: boolean;
  $isNotNull?: boolean;
};
type HavingInput = Record<string, HavingScalar | HavingOperators>;

export type QueryCacheOptions = {
  /** How long this specific query result should stay in the in-process cache. */
  ttlMs: number;
};

type CacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

const queryResultCache = new Map<string, CacheEntry<unknown>>();
let lastCachePruneMs = 0;

function cacheKeyFor(
  operation: string,
  sql: string,
  params: any[],
  raw: boolean,
  includes: string[],
): string {
  return JSON.stringify({ operation, sql, params, raw, includes });
}

// =============================================================================
// QueryBuilder Class
// =============================================================================

/**
 * A Fluent Query Builder that accumulates query state via chaining
 * and only executes when a terminal method is called (.all(), .get())
 * or when it is `await`-ed (thenable).
 *
 * Supports two WHERE styles:
 * - Object-style: `.where({ name: 'Alice', age: { $gt: 18 } })`
 * - Callback-style (AST): `.where((c, f, op) => op.and(op.eq(c.name, 'Alice'), op.gt(c.age, 18)))`
 */
export class QueryBuilder<
  T extends Record<string, any>,
  TResult extends Record<string, any> = T,
  S extends SchemaMap = {},
  R extends RelationsConfig = {},
  Table extends string = never,
  Selected extends boolean = false,
  O = {},
  Writable extends boolean = true,
> {
  private iqo: IQO;
  private tableName: string;
  private executor: (sql: string, params: any[], raw: boolean) => any[];
  private singleExecutor: (
    sql: string,
    params: any[],
    raw: boolean,
  ) => any | null;
  private joinResolver:
    | ((
        fromTable: string,
        toTable: string,
      ) => { fk: string; pk: string } | null)
    | null;
  private conditionResolver:
    ((conditions: Record<string, any>) => Record<string, any>) | null;
  private eagerLoader:
    | ((
        parentTable: string,
        relation: string,
        parentIds: number[],
        sourceRows?: any[],
      ) => { key: string; table: string; groups: Map<number, any> ; many: boolean } | null)
    | null;
  private cacheTtlMs: number | null = null;
  private deleteExecutor: ((where: string, params: any[]) => number) | null = null;


  constructor(
    tableName: string,
    executor: (sql: string, params: any[], raw: boolean) => any[],
    singleExecutor: (sql: string, params: any[], raw: boolean) => any | null,
    joinResolver?:
      | ((
          fromTable: string,
          toTable: string,
        ) => { fk: string; pk: string } | null)
      | null,
    conditionResolver?:
      ((conditions: Record<string, any>) => Record<string, any>) | null,
    eagerLoader?:
      | ((
          parentTable: string,
          relation: string,
          parentIds: number[],
        sourceRows?: any[],
        ) => { key: string; table: string; groups: Map<number, any> ; many: boolean } | null)
      | null,
  ) {
    this.tableName = tableName;
    this.executor = executor;
    this.singleExecutor = singleExecutor;
    this.joinResolver = joinResolver ?? null;
    this.conditionResolver = conditionResolver ?? null;
    this.eagerLoader = eagerLoader ?? null;
    this.iqo = {
      selects: [],
      wheres: [],
      whereOrs: [],
      whereOrBranches: [],
      rawWheres: [],
      whereAST: null,
      joins: [],
      groupBy: [],
      having: [],
      limit: null,
      offset: null,
      orderBy: [],
      includes: [],
      raw: false,
      distinct: false,
    };
  }

  /** Specify which columns to select. If called with no arguments, defaults to `*`. */
  select(): this;
  select<K extends keyof StoredColumns<T> & string>(
    ...cols: K[]
  ): QueryBuilder<
    T, Selected extends true ? TResult & Pick<T, K> : Pick<T, K>,
    S, R, Table, true, O, Writable
  >;
  select(...cols: string[]): any {
    this.iqo.selects.push(...cols);
    return this;
  }

  /**
   * Add WHERE conditions. Two calling styles:
   *
   * **Object-style** (simple equality and operators):
   * ```ts
   * .where({ name: 'Alice' })
   * .where({ age: { $gt: 18 } })
   * ```
   *
   * **Callback-style** (AST-based, full SQL expression power):
   * ```ts
   * .where((c, f, op) => op.and(
   *   op.eq(f.lower(c.name), 'alice'),
   *   op.gt(c.age, 18)
   * ))
   * ```
   */
  where(
    criteriaOrCallback:
      | WhereInput<T>
      | WhereCallback<T>,
  ): this {
    if (typeof criteriaOrCallback === "function") {
      const ast = (criteriaOrCallback as WhereCallback<T>)(
        createColumnProxy<T>(),
        createFunctionProxy(),
        op,
      );
      if (this.iqo.whereAST) {
        this.iqo.whereAST = {
          type: "operator",
          op: "AND",
          left: this.iqo.whereAST,
          right: ast,
        };
      } else {
        this.iqo.whereAST = ast;
      }
    } else {
      const resolved = this.conditionResolver
        ? this.conditionResolver(criteriaOrCallback as Record<string, any>)
        : criteriaOrCallback;

      for (const [key, value] of Object.entries(resolved)) {
        if (key === "$or" && Array.isArray(value)) {
          if (value.length === 0) {
            this.iqo.rawWheres.push({ sql: "1 = 0", params: [] });
            continue;
          }
          const orBranches: WhereCondition[][] = [];
          for (const branch of value as Record<string, any>[]) {
            if (!branch || typeof branch !== "object" || Array.isArray(branch) || Object.keys(branch).length === 0)
              throw new Error("$or requires non-empty object branches");
            const resolvedBranch = this.conditionResolver
              ? this.conditionResolver(branch)
              : branch;
            const branchConditions: WhereCondition[] = [];
            for (const [bKey, bValue] of Object.entries(resolvedBranch)) {
              if (
                typeof bValue === "object" &&
                bValue !== null &&
                !Array.isArray(bValue) &&
                !(bValue instanceof Date)
              ) {
                for (const [opKey, operand] of Object.entries(bValue)) {
                  if (!Object.prototype.hasOwnProperty.call(OPERATOR_MAP, opKey))
                    throw new Error(`Unsupported query operator: '${opKey}'`);
                  branchConditions.push({
                    field: bKey,
                    operator: OPERATOR_MAP[opKey as WhereOperator] as WhereCondition["operator"],
                    value: operand,
                  });
                }
              } else {
                branchConditions.push({
                  field: bKey,
                  operator: "=",
                  value: bValue,
                });
              }
            }
            if (branchConditions.length) orBranches.push(branchConditions);
          }
          if (orBranches.length > 0) this.iqo.whereOrBranches!.push(orBranches);
          continue;
        }
        if (key.startsWith("$"))
          throw new Error(`Unsupported query operator: '${key}'`);

        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          !(value instanceof Date)
        ) {
          for (const [opKey, operand] of Object.entries(value)) {
            if (!Object.prototype.hasOwnProperty.call(OPERATOR_MAP, opKey))
              throw new Error(
                `Unsupported query operator: '${opKey}' on field '${key}'.`,
              );
            const sqlOp = OPERATOR_MAP[opKey as WhereOperator];
            if (opKey === "$between") {
              if (!Array.isArray(operand) || operand.length !== 2)
                throw new Error(`$between for '${key}' requires [min, max]`);
            }
            this.iqo.wheres.push({
              field: key,
              operator: sqlOp as WhereCondition["operator"],
              value: operand,
            });
          }
        } else {
          this.iqo.wheres.push({ field: key, operator: "=", value });
        }
      }
    }
    return this;
  }

  /** Set the maximum number of rows to return. */
  limit(n: number): this {
    this.iqo.limit = n;
    return this;
  }

  /** Set the offset for pagination. */
  offset(n: number): this {
    this.iqo.offset = n;
    return this;
  }

  /** Add ORDER BY clauses. */
  orderBy(field: keyof StoredColumns<T> & string, direction: OrderDirection = "asc"): this {
    this.iqo.orderBy.push({ field, direction });
    return this;
  }

  /**
   * Join another table. Two calling styles:
   *
   * **Accessor-based** (auto-infers FK from relationships):
   * ```ts
   * db.trees.select('name').join(db.forests, ['name']).all()
   * ```
   *
   * **String-based** (manual FK):
   * ```ts
   * db.trees.select('name').join('forests', 'forestId', ['name']).all()
   * ```
   */
  join(accessor: { _tableName: string }, columns?: string[]):
    QueryBuilder<T, RawRow<TResult>, S, R, Table, Selected, O, Writable>;
  join<J extends string, C extends string = never>(table: J, fk: string, columns?: readonly C[], pk?: string):
    QueryBuilder<T, RawRow<TResult> & JoinedColumns<S, J, C>, S, R, Table, Selected, O, Writable>;
  join(
    tableOrAccessor: string | { _tableName: string },
    fkOrCols?: string | string[],
    colsOrPk?: readonly string[] | string,
    pk?: string,
  ): this {
    let table: string;
    let fromCol: string;
    let toCol: string;
    let columns: string[];

    if (
      typeof tableOrAccessor === "object" &&
      "_tableName" in tableOrAccessor
    ) {
      table = tableOrAccessor._tableName;
      columns = Array.isArray(fkOrCols) ? fkOrCols : [];
      if (!this.joinResolver)
        throw new Error(
          `Cannot auto-resolve join: no relationship data available`,
        );
      const resolved = this.joinResolver(this.tableName, table);
      if (!resolved)
        throw new Error(
          `No relationship found between '${this.tableName}' and '${table}'`,
        );
      fromCol = resolved.fk;
      toCol = resolved.pk;
    } else {
      table = tableOrAccessor;
      fromCol = fkOrCols as string;
      columns = Array.isArray(colsOrPk) ? [...colsOrPk] : [];
      toCol = (typeof colsOrPk === "string" ? colsOrPk : pk) ?? "id";
    }

    this.iqo.joins.push({ table, fromCol, toCol, columns });
    this.iqo.raw = true;
    return this;
  }

  /** Skip Zod parsing and return raw SQLite row objects. */
  raw(): QueryBuilder<T, RawRow<TResult>, S, R, Table, Selected, O, Writable> {
    this.iqo.raw = true;
    return this as unknown as QueryBuilder<T, RawRow<TResult>, S, R, Table, Selected, O, Writable>;
  }

  /**
   * Cache this query builder's terminal read result in-process for a short TTL.
   *
   * Useful for hot read-only views/aggregates such as rolling 1m/5m/15m
   * price windows. Mutations are never cached, and caching is opt-in per query.
   *
   * ```ts
   * db.tokenPriceWindows.select().where({ mint }).cache({ ttlMs: 500 }).get()
   * ```
   */
  cache(options: QueryCacheOptions | number): this {
    const ttlMs = typeof options === "number" ? options : options.ttlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(
        "cache({ ttlMs }) requires a positive finite ttlMs value",
      );
    }
    this.cacheTtlMs = Math.trunc(ttlMs);
    return this;
  }

  /** Disable caching on this query builder. */
  noCache(): this {
    this.cacheTtlMs = null;
    return this;
  }

  /**
   * Add a raw SQL WHERE fragment with parameterized values.
   * Can be combined with `.where()` — fragments are AND'd together.
   *
   * ```ts
   * db.users.select().whereRaw('score > ? AND role != ?', [50, 'guest']).all()
   * ```
   */
  whereRaw(sql: string, params: any[] = []): this {
    this.iqo.rawWheres.push({ sql, params });
    return this;
  }

  /**
   * Filter by column value being in a list or subquery.
   * ```ts
   * db.users.select().whereIn('id', [1, 2, 3]).all()
   * db.users.select().whereIn('id', db.orders.select('userId')).all()
   * ```
   */
  whereIn<K extends keyof StoredColumns<T> & string>(
    column: K,
    values: StoredColumns<T>[K][] | QueryBuilder<any, any>,
  ): this {
    if (Array.isArray(values)) {
      this.iqo.wheres.push({
        field: column, operator: "IN", value: values,
      });
    } else {
      // Subquery: compile the inner QueryBuilder's IQO
      const inner = compileIQO((values as any).tableName, (values as any).iqo);
      this.iqo.rawWheres.push({
        sql: `${quoteIdentifierPath(column)} IN (${inner.sql})`,
        params: inner.params,
      });
    }
    return this;
  }

  /**
   * Filter by column value NOT being in a list or subquery.
   */
  whereNotIn<K extends keyof StoredColumns<T> & string>(
    column: K,
    values: StoredColumns<T>[K][] | QueryBuilder<any, any>,
  ): this {
    if (Array.isArray(values)) {
      this.iqo.wheres.push({
        field: column, operator: "NOT IN", value: values,
      });
    } else {
      const inner = compileIQO((values as any).tableName, (values as any).iqo);
      this.iqo.rawWheres.push({
        sql: `${quoteIdentifierPath(column)} NOT IN (${inner.sql})`,
        params: inner.params,
      });
    }
    return this;
  }

  /**
   * Eagerly load a related entity and attach as an array property.
   *
   * Runs a single batched query (WHERE fk IN (...)) per relation,
   * avoiding the N+1 problem of lazy navigation.
   */
  with<const Path extends string>(
    ...relations: Path[]
  ): QueryBuilder<T, EagerWith<TResult, S, R, Table, Path, [], O>, S, R, Table, Selected, O, Writable> {
    this.iqo.includes.push(...relations);
    return this as unknown as QueryBuilder<
      T, EagerWith<TResult, S, R, Table, Path, [], O>, S, R, Table, Selected, O, Writable
    >;
  }

  /** Internal: apply eager loads to a set of results */
  private _applyEagerLoads(results: T[]): T[] {
    if (
      this.iqo.includes.length === 0 ||
      !this.eagerLoader ||
      results.length === 0
    ) {
      return results;
    }

    // A tree ensures that overlapping paths (posts and posts.comments) load
    // the same child objects, regardless of the order of .with() arguments.
    type IncludeNode = Map<string, IncludeNode>;
    const tree: IncludeNode = new Map();
    for (const path of this.iqo.includes) {
      const parts = path.split(".");
      if (parts.some((part) => !part))
        throw new Error(`Invalid relation path '${path}'`);
      let node = tree;
      for (const part of parts) {
        if (!node.has(part)) node.set(part, new Map());
        node = node.get(part)!;
      }
    }
    const visit = (table: string, rows: any[], node: IncludeNode): void => {
      if (rows.length === 0) return;
      const ids = [...new Set(rows.map((row) => row.id).filter((id) => typeof id === "number"))];
      if (ids.length === 0) return;
      for (const [relation, children] of node) {
        const loaded = this.eagerLoader!(
          table, relation, ids, this.iqo.raw ? undefined : rows,
        );
        if (!loaded) continue;
        const next: any[] = [];
        for (const row of rows) {
          const value = loaded.groups.get(row.id) ?? (loaded.many ? [] : null);
          row[loaded.key] = value;
          if (Array.isArray(value)) next.push(...value);
          else if (value != null) next.push(value);
        }
        visit(loaded.table, next, children);
      }
    };
    visit(this.tableName, results as any[], tree);

    return results;
  }

  private _cached<TValue>(
    operation: string,
    sql: string,
    params: any[],
    raw: boolean,
    compute: () => TValue,
  ): TValue {
    if (!this.cacheTtlMs) return compute();

    const key = cacheKeyFor(operation, sql, params, raw, this.iqo.includes);
    const now = Date.now();
    if (now - lastCachePruneMs > 60_000) {
      lastCachePruneMs = now;
      for (const [entryKey, entry] of queryResultCache) {
        if (entry.expiresAtMs <= now) queryResultCache.delete(entryKey);
      }
    }
    const cached = queryResultCache.get(key) as CacheEntry<TValue> | undefined;
    if (cached && cached.expiresAtMs > now) {
      return cached.value;
    }

    const value = compute();
    queryResultCache.set(key, {
      expiresAtMs: now + this.cacheTtlMs,
      value,
    });
    return value;
  }

  // ---------- Terminal / Execution Methods ----------

  /** Execute the query and return all matching rows. */
  all(): TResult[] {
    const { sql, params } = compileIQO(this.tableName, this.iqo);
    return this._cached("all", sql, params, this.iqo.raw, () => {
      const results = this.executor(sql, params, this.iqo.raw);
      return this._applyEagerLoads(results) as unknown as TResult[];
    });
  }

  /** Execute the query and return the first matching row, or null. */
  get(): TResult | null {
    this.iqo.limit = 1;
    const { sql, params } = compileIQO(this.tableName, this.iqo);
    return this._cached("get", sql, params, this.iqo.raw, () => {
      const result = this.singleExecutor(sql, params, this.iqo.raw);
      if (!result) return null;
      const [loaded] = this._applyEagerLoads([result]);
      return (loaded ?? null) as unknown as TResult | null;
    });
  }

  /** Execute the query and return the count of matching rows. */
  count(): number {
    // Reuse compileIQO to avoid duplicating WHERE logic
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    // With groupBy, COUNT(*) would be computed per group and the first group
    // returned; count the result rows (the groups) instead, like all().length.
    const countSql = this.iqo.groupBy.length > 0
      ? `SELECT COUNT(*) as count FROM (${selectSql})`
      : selectSql.replace(
        /^SELECT .+? FROM/,
        "SELECT COUNT(*) as count FROM",
      );
    return this._cached("count", countSql, params, true, () => {
      const results = this.executor(countSql, params, true);
      return (results[0] as any)?.count ?? 0;
    });
  }

  /** Alias for get() — returns the first matching row or null. */
  first(): TResult | null {
    return this.get();
  }

  /**
   * Return the first matching row or throw if none found.
   * ```ts
   * const user = db.users.select().where({ id: 1 }).firstOrFail();
   * // throws Error('No matching row found') if id=1 doesn't exist
   * ```
   */
  firstOrFail(): TResult {
    const row = this.get();
    if (row === null) throw new Error("No matching row found");
    return row;
  }

  /** Returns true if at least one row matches the query. */
  exists(): boolean {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    // Preserve the original query's LIMIT/OFFSET, grouping and JOIN semantics.
    const existsSql = `SELECT EXISTS(${selectSql}) AS present`;
    return this._cached("exists", existsSql, params, true, () => {
      const results = this.executor(existsSql, params, true);
      return Boolean((results[0] as any)?.present);
    });
  }

  /** Group results by one or more columns. */
  groupBy(...fields: string[]): this {
    this.iqo.groupBy.push(...fields);
    return this;
  }

  /** Return only distinct rows. */
  distinct(): this {
    this.iqo.distinct = true;
    return this;
  }

  /**
   * Include soft-deleted rows in query results.
   * Only relevant when `softDeletes: true` is set in Database options.
   */
  withTrashed(): this {
    // Remove the auto-injected `deletedAt IS NULL` filter
    this.iqo.wheres = this.iqo.wheres.filter(
      (w) => !(w.field === "deletedAt" && w.operator === "IS NULL"),
    );
    return this;
  }

  /**
   * Return only soft-deleted rows.
   * Only relevant when `softDeletes: true` is set in Database options.
   */
  onlyTrashed(): this {
    // Remove the auto-injected `deletedAt IS NULL` and add `deletedAt IS NOT NULL`
    this.iqo.wheres = this.iqo.wheres.filter(
      (w) => !(w.field === "deletedAt" && w.operator === "IS NULL"),
    );
    this.iqo.wheres.push({
      field: "deletedAt",
      operator: "IS NOT NULL",
      value: null,
    });
    return this;
  }

  /**
   * Add HAVING conditions (used after groupBy for aggregate filtering).
   *
   * ```ts
   * db.orders.select('user_id').groupBy('user_id')
   *   .having({ 'COUNT(*)': { $gt: 5 } })
   *   .raw().all()
   * ```
   */
  having(conditions: HavingInput): this {
    for (const [field, value] of Object.entries(conditions)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        for (const [opKey, operand] of Object.entries(value)) {
          const sqlOp = OPERATOR_MAP[opKey as WhereOperator];
          if (!sqlOp)
            throw new Error(`Unsupported having operator: '${opKey}'`);
          this.iqo.having.push({
            field,
            operator: sqlOp as WhereCondition["operator"],
            value: operand,
          });
        }
      } else {
        this.iqo.having.push({ field, operator: "=", value });
      }
    }
    return this;
  }

  // ---------- Aggregate Methods ----------

  /** Quoted column for an aggregate; refuses grouped queries. */
  private _aggregateColumn(fn: string, field: string): string {
    if (this.iqo.groupBy.length > 0)
      throw new Error(
        `${fn}() on a grouped query would return the first group's value; ` +
          `use countGrouped() or select(...) with SQL aggregates per group`,
      );
    return `"${String(field).replaceAll('"', '""')}"`;
  }

  /** Returns the SUM of a numeric column. */
  sum(field: keyof StoredColumns<T> & string): number {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const aggSql = selectSql.replace(
      /^SELECT .+? FROM/,
      // TOTAL() never overflows (SUM() throws on big INTEGERs) and is 0.0 when empty.
      `SELECT TOTAL(${this._aggregateColumn("sum", field)}) as val FROM`,
    );
    return this._cached(`sum:${String(field)}`, aggSql, params, true, () => {
      const results = this.executor(aggSql, params, true);
      return (results[0] as any)?.val ?? 0;
    });
  }

  /** Returns the AVG of a numeric column. */
  avg(field: keyof StoredColumns<T> & string): number {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const aggSql = selectSql.replace(
      /^SELECT .+? FROM/,
      `SELECT AVG(${this._aggregateColumn("avg", field)}) as val FROM`,
    );
    return this._cached(`avg:${String(field)}`, aggSql, params, true, () => {
      const results = this.executor(aggSql, params, true);
      return (results[0] as any)?.val ?? 0;
    });
  }

  /** Returns the MIN of a column. */
  min(field: keyof StoredColumns<T> & string): number | string | Uint8Array | null {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const aggSql = selectSql.replace(
      /^SELECT .+? FROM/,
      `SELECT MIN(${this._aggregateColumn("min", field)}) as val FROM`,
    );
    return this._cached(`min:${String(field)}`, aggSql, params, true, () => {
      const results = this.executor(aggSql, params, true);
      return (results[0] as any)?.val ?? null;
    });
  }

  /** Returns the MAX of a column. */
  max(field: keyof StoredColumns<T> & string): number | string | Uint8Array | null {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const aggSql = selectSql.replace(
      /^SELECT .+? FROM/,
      `SELECT MAX(${this._aggregateColumn("max", field)}) as val FROM`,
    );
    return this._cached(`max:${String(field)}`, aggSql, params, true, () => {
      const results = this.executor(aggSql, params, true);
      return (results[0] as any)?.val ?? null;
    });
  }

  /** Paginate results. Returns { data, total, page, perPage, pages }. */
  paginate(
    page: number = 1,
    perPage: number = 20,
  ): {
    data: TResult[];
    total: number;
    page: number;
    perPage: number;
    pages: number;
  } {
    if (!Number.isSafeInteger(page) || page < 1)
      throw new TypeError(`paginate(): page must be an integer >= 1, got ${page}`);
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 10_000)
      throw new TypeError(`paginate(): perPage must be an integer from 1 to 10000, got ${perPage}`);
    // Work on the query as given, without changing this builder.
    const saved = { limit: this.iqo.limit, offset: this.iqo.offset, orderBy: this.iqo.orderBy };
    try {
      this.iqo.limit = null;
      this.iqo.offset = null;
      // Count the whole result set (correct with groupBy and distinct too).
      const { sql: allSql, params } = compileIQO(this.tableName, this.iqo);
      const countSql = `SELECT COUNT(*) AS count FROM (${allSql})`;
      const total = Number((this.executor(countSql, params, true)[0] as any)?.count ?? 0);
      // Without an order, rows can repeat or go missing between pages.
      if (this.iqo.orderBy.length === 0)
        this.iqo.orderBy = [{ field: "id", direction: "asc" } as any];
      this.iqo.limit = perPage;
      this.iqo.offset = (page - 1) * perPage;
      const data = this.all();
      return { data, total, page, perPage, pages: Math.ceil(total / perPage) };
    } finally {
      this.iqo.limit = saved.limit;
      this.iqo.offset = saved.offset;
      this.iqo.orderBy = saved.orderBy;
    }
  }

  /**
   * Count rows per group. Must call `.groupBy()` first.
   * Returns an array of objects with the grouped column(s) and a `count` field.
   *
   * ```ts
   * db.users.select('role').groupBy('role').countGrouped()
   * // → [{ role: 'admin', count: 5 }, { role: 'member', count: 12 }]
   * ```
   */
  countGrouped(): (Record<string, any> & { count: number })[] {
    if (this.iqo.groupBy.length === 0) {
      throw new Error("countGrouped() requires at least one groupBy() call");
    }
    const groupCols = this.iqo.groupBy.map((c) => `"${c}"`).join(", ");
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const aggSql = selectSql.replace(
      /^SELECT .+? FROM/,
      `SELECT ${groupCols}, COUNT(*) as count FROM`,
    );
    return this._cached(
      "countGrouped",
      aggSql,
      params,
      true,
      () => this.executor(aggSql, params, true) as any,
    );
  }

  // ---------- Query Inspection ----------

  /**
   * Compile and return the SQL string + params without executing.
   * ```ts
   * db.users.select().where({ role: 'admin' }).toSQL()
   * // → { sql: 'SELECT * FROM "users" WHERE "role" = ?', params: ['admin'] }
   * ```
   */
  toSQL(): { sql: string; params: any[] } {
    return compileIQO(this.tableName, this.iqo);
  }

  // ---------- Convenience Methods ----------

  /**
   * Return a flat array of values for a single column.
   * ```ts
   * db.users.select().pluck('name') // → ['Alice', 'Bob', 'Charlie']
   * ```
   */
  pluck<K extends keyof StoredColumns<T> & string>(
    column: K,
  ): RawValue<StoredColumns<T>[K]>[] {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const pluckSql = selectSql.replace(
      /^SELECT .+? FROM/,
      `SELECT "${column}" FROM`,
    );
    return this._cached(
      `pluck:${String(column)}`,
      pluckSql,
      params,
      true,
      () => {
        const results = this.executor(pluckSql, params, true);
        return results.map((r: any) => r[column]);
      },
    ) as RawValue<StoredColumns<T>[K]>[];
  }

  /** Clone this QueryBuilder so you can fork a query. */
  clone(): QueryBuilder<T, TResult, S, R, Table, Selected, O, Writable> {
    const cloned = new QueryBuilder<T, TResult, S, R, Table, Selected, O, Writable>(
      this.tableName,
      this.executor,
      this.singleExecutor,
      this.joinResolver,
      this.conditionResolver,
      this.eagerLoader,
    );
    // Deep-copy the IQO state
    (cloned as any).iqo = JSON.parse(JSON.stringify(this.iqo));
    (cloned as any).cacheTtlMs = this.cacheTtlMs;
    (cloned as any).deleteExecutor = this.deleteExecutor;
    return cloned;
  }

  // ---------- Batch Mutations ----------

  /**
   * Update all rows matching the current query's WHERE conditions.
   * Returns the number of affected rows.
   * ```ts
   * db.users.select().where({ role: 'guest' }).updateAll({ role: 'member' })
   * ```
   */
  updateAll(data: Writable extends true ? Partial<StoredColumns<T>> : never): number {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    // Extract WHERE clause from compiled SELECT
    const whereMatch = selectSql.match(
      /WHERE (.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s+HAVING|$)/s,
    );
    const wherePart = whereMatch ? whereMatch[1] : "1=1";

    const setClauses: string[] = [];
    const setParams: any[] = [];
    if (Object.keys(data).length === 0) return 0;
    for (const [col, val] of Object.entries(data)) {
      setClauses.push(`"${col}" = ?`);
      if (
        val !== null &&
        val !== undefined &&
        typeof val === "object" &&
        !(val instanceof Buffer) &&
        !(val instanceof Date)
      ) {
        setParams.push(JSON.stringify(val));
      } else {
        setParams.push(val);
      }
    }

    const updateSql = `UPDATE "${this.tableName}" SET ${setClauses.join(", ")} WHERE ${wherePart}`;
    this.executor(updateSql, [...setParams, ...params], true);
    // Return affected rows via changes()
    const result = this.executor(`SELECT changes() as c`, [], true);
    return (result[0] as any)?.c ?? 0;
  }

  /**
   * Delete all rows matching the current query's WHERE conditions.
   * Returns the number of deleted rows.
   * ```ts
   * db.users.select().where({ role: 'guest' }).deleteAll()
   * ```
   */
  deleteAll(this: Writable extends true ? QueryBuilder<T, TResult, S, R, Table, Selected, O, Writable> : never): number {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const whereMatch = selectSql.match(
      /WHERE (.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s+HAVING|$)/s,
    );
    const wherePart = whereMatch?.[1] ?? "1=1";

    if (this.deleteExecutor) return this.deleteExecutor(wherePart, params);
    const deleteSql = `DELETE FROM "${this.tableName}" WHERE ${wherePart}`;
    this.executor(deleteSql, params, true);
    const result = this.executor(`SELECT changes() as c`, [], true);
    return (result[0] as any)?.c ?? 0;
  }

  /**
   * Atomically increment a numeric column for matching rows.
   * Returns the number of affected rows.
   * ```ts
   * db.users.select().where({ id: 1 }).increment('score', 10)
   * ```
   */
  increment(column: Writable extends true ? keyof StoredColumns<T> & string : never, amount: number = 1): number {
    const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
    const whereMatch = selectSql.match(
      /WHERE (.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s+HAVING|$)/s,
    );
    const wherePart = whereMatch ? whereMatch[1] : "1=1";

    const sql = `UPDATE "${this.tableName}" SET "${column}" = "${column}" + ? WHERE ${wherePart}`;
    this.executor(sql, [amount, ...params], true);
    const result = this.executor(`SELECT changes() as c`, [], true);
    return (result[0] as any)?.c ?? 0;
  }

  /**
   * Atomically decrement a numeric column for matching rows.
   * Returns the number of affected rows.
   * ```ts
   * db.users.select().where({ id: 1 }).decrement('score', 5)
   * ```
   */
  decrement(column: Writable extends true ? keyof StoredColumns<T> & string : never, amount: number = 1): number {
    return this.increment(column, -amount);
  }

  // ---------- Thenable (async/await support) ----------

  then<TThen1 = TResult[], TThen2 = never>(
    onfulfilled?: ((value: TResult[]) => TThen1 | PromiseLike<TThen1>) | null,
    onrejected?: ((reason: any) => TThen2 | PromiseLike<TThen2>) | null,
  ): Promise<TThen1 | TThen2> {
    try {
      const result = this.all();
      return Promise.resolve(result).then(onfulfilled, onrejected);
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
  }
}
