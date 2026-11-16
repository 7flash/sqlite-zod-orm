# sqlite-zod-orm

Type-safe SQLite for Bun: define tables with Zod, query and traverse relationships fluently, and perform everyday CRUD without writing SQL.

## Quick Start

Install:

```bash
bun add sqlite-zod-orm
```

Create two related tables, insert records, and query with a relationship:

```typescript
import { Database, z } from 'sqlite-zod-orm';
const db = new Database('app.db', {
    users: z.object({ name: z.string() }),
    posts: z.object({
        title: z.string(),
        user_id: z.number(),
    }),
}, {
    relations: { posts: { user_id: 'users' } },
});
const alice = db.users.insert({ name: 'Alice' });
const post = db.posts.insert({ title: 'Hello', user_id: alice.id });
const posts = db.posts.select().with('user').all();
console.log(posts[0].user); // eagerly loaded user
console.log(post.user(), alice.posts()); // lazy forward and inverse
```

That's it. `new Database()` creates the tables automatically. Inserts return typed entities, queries return typed results, and declared relationships provide navigation accessors and eager loading.

No migrations to write for supported schema changes. No SQL required for ordinary CRUD.

**Requirements:** Bun ≥ 1.0 and Zod ≥ 4.6.7.

## Contents

- **Getting started:** [Requirements](#requirements), [Configuration](#configuration), [CRUD](#crud), [Relationships](#relationships)
- **Schema safety:** [Migrations](#migrations), [Persistence, Reactivity & Errors](#persistence-reactivity--errors), [Schema Diffing](#schema-diffing)
- **Queries:** [Fluent Query Builder](#fluent-query-builder), [Select Type Narrowing](#select-type-narrowing), [Aggregates](#aggregates), [Pagination](#pagination)
- **Writes and lifecycle:** [Batch Mutations](#batch-mutations), [Cascade Deletes](#cascade-deletes), [Soft Deletes & Timestamps](#soft-deletes--timestamps), [Computed Getters](#computed-getters), [Lifecycle Hooks](#lifecycle-hooks), [Transactions](#transactions)
- **Data and SQL:** [Data Import / Export](#data-import--export), [Views](#views), [Raw SQL](#raw-sql)
- **Reference:** [Full Feature List](#full-feature-list), [Public API](#public-api), [Contributing](#contributing), [Development checks](#development-checks), [License](#license)

## Requirements

- **Bun** ≥ 1.0 (uses `bun:sqlite` native bindings)
- **Zod** ≥ 4.6.7

The ORM uses measure-fn 5.x and Zod 4.x at runtime.

## Configuration

The Quick Start uses the minimum configuration needed for relationships.

A more complete database can enable timestamps, soft deletes, and typed SQL views:

```typescript
import { Database, defineView, z } from 'sqlite-zod-orm';

const db = new Database('app.db', {
    users: z.object({
        name: z.string(),
        email: z.string(),
        score: z.number().default(0),
    }),
    posts: z.object({
        title: z.string(),
        body: z.string(),
        user_id: z.number(),
    }),
}, {
    relations: { posts: { user_id: 'users' } },
    timestamps: true,
    softDeletes: true,
    views: {
        active_users: defineView(z.object({
            name: z.string(),
            email: z.string(),
        }), `
            SELECT name, email
            FROM users
            WHERE deletedAt IS NULL
        `),
    },
});
```

Tables are auto-created and auto-migrated from your Zod schemas. No SQL required for table definitions or ordinary queries.

Zod defines the stored fields and their TypeScript types. Database options configure relationships, generated columns, views, and other behavior.

**Example scope:** The following sections demonstrate individual APIs. References to fields such as `role`, `first`, and `last`, or additional tables such as `orders`, assume those fields and tables are present in the corresponding application schema.

## CRUD

```typescript
// Insert
const user = db.users.insert({ name: 'Alice', email: 'alice@co.com' });

// Read
const all = db.users.select().all();
const one = db.users.get(1);
const found = db.users.select().where({ name: 'Alice' }).first();

// Update (auto-persists via proxy)
user.score = 100;  // ← saved to DB automatically

// Delete
db.users.delete(1);

// Batch
db.users.insertMany([{ name: 'Bob', email: 'b@co.com' }, { name: 'Charlie', email: 'c@co.com' }]);
db.users.upsertMany([{ id: 1, name: 'Updated Alice' }], 'id');
```

Inserted and retrieved entities support proxy-based automatic persistence. Assigning a stored property writes the change to SQLite.

For explicit bulk updates and deletes, see [Batch Mutations](#batch-mutations).

## Relationships

Declare foreign keys in the `relations` option:

```typescript
const db = new Database(':memory:', {
    users: z.object({ name: z.string() }),
    posts: z.object({
        title: z.string(),
        user_id: z.number(),
    }),
}, {
    relations: { posts: { user_id: 'users' } },
});
```

Relationships support forward and inverse navigation:

```typescript
// Navigation (lazy, proxy-based)
const post = db.posts.get(1);
post.user();         // → related user object

const user = db.users.get(1);
user.posts();        // → array of user's posts

// Eager loading (no N+1)
db.posts.select().with('user').all();
```

The eager-loading example uses `user` because the foreign-key column is named `user_id`.

### Relationship accessor names

Navigation accessors strip a trailing `_id` (`author_id` becomes `author()`).

If that name is a stored schema field or an entity method (`id`, `update`,
`delete`), `Relation` is appended until the name is available. For example,
`agentRef` stays numeric and its parent is accessed with `agentRefRelation()`.

Inverse accessors follow the same rule: a stored `books` field is preserved
and children are accessed with `booksRelation()`.

**Important:** The automatic stripping rule applies to a trailing `_id`. A
camelCase field such as `userId` does not become `user()` under that rule.
Because `userId` is already a stored field, its relationship accessor is
`userIdRelation()`.

Use `user_id` when you want the simpler `user()` accessor, as in the Quick Start.

When **multiple foreign keys** connect the same child table to one parent,
**every** inverse is named `<childTable>By<FK>` (FK in PascalCase, converting
underscores to word boundaries), independent of declaration order.

For example, `grants.authorRef`, `grants.agentRef` and `grants.auditorRef`
referencing `agents` produce:

```typescript
agent.grantsByAuthorRef();
agent.grantsByAgentRef();
agent.grantsByAuditorRef();
```

Each returns only children matching its own FK.

A self-reference is also FK-qualified: `nodes.nodes_id → nodes` yields forward
`nodes()` and inverse `nodesByNodesId()`.

If an inverse name conflicts with a stored field, generated field, method or
forward accessor, append `Relation` until free. Conflicting forward names are
rejected.

`.with()` uses the same inverse names (and yields arrays instead of lazy
functions).

For example:

```typescript
db.agents.select().with('grantsByAuthorRef').all();
```

Automatic joins are rejected when more than one FK can connect the selected
tables; supply the FK explicitly:

```typescript
db.grants.select().join('agents', 'authorRef', ['name']).all();
```

## Migrations

Schemas are synchronized automatically when a `Database` is initialized. New
tables are created, and supported schema changes rebuild affected tables
transactionally while preserving existing data.

**Automatic does not mean destructive changes are silently accepted.**

In 4.0.0, initialization refuses unsafe or ambiguous migrations with an error,
including:

- **Type changes to populated columns:** existing non-null data is not silently converted to a different declared type.
- **Drop-plus-add changes:** ambiguous combinations of removed and added columns are not silently treated as safe data mappings.
- **Legacy constraints:** rebuilds refuse to silently discard existing `CHECK`, `NOT NULL`, or `ON CONFLICT` semantics that cannot be preserved.
- **Differing foreign-key actions:** conflicting `ON DELETE` or `ON UPDATE` actions are not silently rewritten.
- **Broken triggers:** dependent triggers that cannot be recreated correctly cause the migration to fail.

A rejected migration rolls back rather than leaving a partially modified
database. Resolve the incompatibility explicitly before retrying initialization.

See [UPGRADING.md](UPGRADING.md) for 4.0.0 migration behavior, compatibility
changes, and upgrade guidance.

### How automatic reconstruction works

Schema changes (including added fields) reconstruct affected tables in a
transaction. Each rebuild retains a `table_vN` data snapshot, preserves row IDs
and existing column values, initializes added nullable/defaulted fields, and
recreates indexes and triggers on the live table.

Inline column `UNIQUE` constraints are reconstructed as named unique indexes.

Declared relationships, incoming foreign-key references and existing views
remain directed at the live table.

If a required field cannot be populated, an index cannot be recreated,
foreign keys fail validation, or a dependent view becomes invalid, initialization
rolls back instead of committing a partial migration.

Historical snapshots are available for explicit recovery through
`db.migrator()`.

The package also exports `createMigrator`, `DatabaseMigrator`, and `runCli`
for explicit migration tooling. See [UPGRADING.md](UPGRADING.md) for the
recommended upgrade workflow.

### Startup locking

All startup schema work (tables, indexes, unique constraints, views and change
tracking) runs under `BEGIN IMMEDIATE`.

SQLite waits for locks before WAL or schema work; configure the wait with
`{ busyTimeout: 10000 }` (milliseconds, default 5000; zero disables waiting).

If the timeout expires, SQLite throws rather than continuing initialization.

## Persistence, Reactivity & Errors

### Automatic persistence

Entities use proxies to persist property changes:

```typescript
const user = db.users.get(1);
user.score = 100; // automatically saved to SQLite
```

This is write-through persistence, not a requirement to call `.save()` after
every property assignment.

The database also installs change tracking during startup.

**Reactivity distinction:** automatic persistence and change tracking should
not be confused with a documented live-query subscription API. This README
does not define an API for subscribing to query-result changes.

The public entry point exports `ChangeEvent` as a TypeScript type. It is not
a standalone runtime function.

### Error behavior

Operations fail rather than silently changing semantics when database
constraints or required guarantees cannot be satisfied.

- **Initialization:** unsafe migrations, invalid dependent views, foreign-key validation failures, and indexes or triggers that cannot be recreated abort the schema transaction.
- **Transactions:** an error thrown inside a transaction callback rolls back that transaction; nested transactions use savepoints.
- **Lock contention:** SQLite waits up to `busyTimeout`, then throws when the lock cannot be acquired.
- **Ambiguous relationships:** conflicting forward accessor names are rejected, and ambiguous automatic joins require an explicit FK.
- **No automatic retries:** transaction callbacks are not replayed after failures.

Use normal error handling around initialization and mutations when the
application needs to recover from these failures.

## Fluent Query Builder

```typescript
db.users.select()
    .where({ score: { $gte: 50 } })
    .orderBy('score', 'DESC')
    .limit(10)
    .all();

// Operators: $gt, $gte, $lt, $lte, $ne, $like, $in, $notIn, $between
db.users.select().where({ name: { $like: '%ali%' } }).all();

// whereIn / whereNotIn (array or subquery)
db.users.select().whereIn('id', [1, 2, 3]).all();
const sub = db.orders.select('userId');
db.users.select().whereIn('id', sub).all();

// Raw WHERE fragments
db.users.select().whereRaw('score > ? AND name != ?', [50, 'Bot']).all();
```

The query builder covers ordinary filtering, ordering, limits, and subqueries
without requiring SQL strings.

Raw WHERE fragments remain available when the fluent API is insufficient.

## Select Type Narrowing

Selecting only specific fields narrows the result type:

```typescript
const names = db.users.select('name', 'email').all();

names[0].name;  // ✅ string
names[0].score; // ❌ TypeScript error — not selected
```

## Aggregates

```typescript
db.users.count();                                   // shorthand
db.users.select().where({ role: 'admin' }).count(); // filtered
db.users.select().sum('score');
db.users.select().avg('score');
db.users.select().min('score');
db.users.select().max('score');
```

The aggregate API also includes `countGrouped`.

## Pagination

```typescript
const page = db.users.select().orderBy('name').paginate(1, 20);
// { data: [...], total: 42, page: 1, perPage: 20, pages: 3 }
```

Pagination is offset-based.

## Batch Mutations

```typescript
db.users.select().where({ role: 'guest' }).updateAll({ role: 'member' }); // → affected count
db.users.select().where({ role: 'spam' }).deleteAll();                    // → deleted count
```

Additional mutation operations include `insertMany`, `upsertMany`, and
`findOrCreate`.

## Cascade Deletes

```typescript
const db = new Database(':memory:', { authors: AuthorSchema, books: BookSchema }, {
    relations: { books: { author_id: 'authors' } },
    cascade: { authors: ['books'] },
});

db.authors.delete(1); // → books with author_id=1 also deleted
```

## Soft Deletes & Timestamps

```typescript
// With softDeletes: true
db.users.delete(1);                                  // sets deletedAt
db.users.select().all();                             // excludes deleted
db.users.select().withTrashed().all();               // includes deleted
db.users.select().onlyTrashed().all();               // only deleted
db.users.restore(1);                                 // un-deletes

// With timestamps: true
user.createdAt;  // auto-set on insert
user.updatedAt;  // auto-bumped on update
```

Both options can be enabled during database construction, as shown in
[Configuration](#configuration).

## Computed Getters

```typescript
const db = new Database(':memory:', { users: UserSchema }, {
    computed: {
        users: { fullName: (u) => `${u.first} ${u.last}` },
    },
});

const user = db.users.get(1);
user.fullName; // 'Alice Smith' — recomputes on access
```

Computed getters provide virtual properties without storing their values
as additional columns.

## Lifecycle Hooks

```typescript
const db = new Database(':memory:', { users: UserSchema }, {
    hooks: {
        users: {
            beforeInsert: (data) => ({ ...data, name: data.name.trim() }),
            afterInsert: (entity) => console.log('Created:', entity.id),
            beforeUpdate: (id, data) => data,
            afterUpdate: (entity) => {},
            beforeDelete: (id) => true,  // return false to cancel
            afterDelete: (id) => {},
        },
    },
});
```

Hooks cover before/after insert, update, and delete operations.

## Transactions

```typescript
db.transaction(() => {
    db.users.insert({ name: 'Alice' });
    db.orders.insert({ userId: 1, amount: 100 });
}); // auto-commits; rolls back on error
```

Transactions are synchronous and default to `BEGIN IMMEDIATE`, acquiring the write
lock before the callback reads.

Lock contention waits for `busyTimeout`; once that expires, SQLite throws.

Callbacks are never automatically replayed. Nested transactions use savepoints.

For read-only work or deliberate alternative locking, pass:

```typescript
db.transaction(work, { mode: 'deferred' });
db.transaction(work, { mode: 'exclusive' });
```

## Schema Diffing

```typescript
const diff = db.diff();
// { users: { added: ['bio'], removed: ['legacy'], typeChanged: [] } }
```

Schema diffing exposes added, removed, and type-changed fields.

For safety rules governing automatic reconstruction, see
[Migrations](#migrations).

## Data Import / Export

```typescript
const backup = db.dump();                      // export all tables as JSON
db.load(backup);                               // restore (truncates first)
db.load(backup, { append: true });             // restore without truncating
db.seed({ users: [{ name: 'Test User' }] });   // additive fixture seeding
```

Schema migration snapshots are separate from application-level JSON
import/export. See [Migrations](#migrations) for `table_vN` snapshots
and explicit recovery.

## Views

```typescript
const db = new Database(':memory:', { trades: TradeSchema }, {
    views: {
        latest_token_prices: defineView(z.object({
            mint: z.string(),
            latestPrice: z.number(),
        }), `
            SELECT mint, MAX(priceSolPerToken) AS latestPrice
            FROM trades
            GROUP BY mint
        `),
    },
});

db.latest_token_prices.select().all();  // typed rows
db.views();                             // ['latest_token_prices']
```

Views are created on startup and recreated automatically when the definition
changes. View accessors are read-only.

Views use SQL for their definitions. The fluent query builder can then query
their typed rows.

## Raw SQL

The fluent API is designed to avoid SQL for ordinary CRUD and querying, but
raw SQL remains available when necessary:

```typescript
db.raw<User>('SELECT * FROM users WHERE score > ?', 50);
db.exec('UPDATE users SET score = 0 WHERE role = ?', 'guest');
```

Raw WHERE fragments are also supported through `whereRaw()`.

This is an escape hatch, not a requirement for using the ORM.

## Full Feature List

- Zod-powered schema definition & runtime validation
- Auto table creation & transactional reconstructive migrations
- Fluent query builder with 10+ operators
- Type-safe select narrowing
- Relationship navigation (lazy proxy + eager loading)
- Soft deletes, timestamps, auto-persist proxy
- Lifecycle hooks (before/after insert/update/delete)
- Aggregates (sum, avg, min, max, count, countGrouped)
- Batch mutations (insertMany, upsertMany, updateAll, deleteAll, findOrCreate)
- Cascade deletes
- Computed/virtual getters
- Data import/export (dump, load, seed)
- Schema diffing
- Transactions
- Pagination
- whereIn/whereNotIn with subquery support
- JSON column auto-serialization
- Unique constraints
- Declarative read-only views
- Debug mode (SQL logging)
- Raw SQL escape hatch

## Public API

The public entry point exports the following primary runtime APIs:

```typescript
import {
    Database,
    defineView,
    z,
    QueryBuilder,
    ColumnNode,
    compileIQO,
    compileAST,
    wrapNode,
    createColumnProxy,
    createFunctionProxy,
    op,
    ConflictMergeHelperRuntime,
    createMigrator,
    DatabaseMigrator,
    runCli,
} from 'sqlite-zod-orm';
```

The introductory examples only require `Database` and `z`. Typed views
add `defineView`.

`Database` methods and generated table accessors, such as `db.users`,
`db.raw()`, `db.diff()`, `db.transaction()`, and `db.migrator()`, are accessed
through database instances rather than imported as standalone functions.

The package also exposes TypeScript-only exports. These are erased at
runtime and should be imported with `import type` when used directly:

```typescript
import type {
    DatabaseType,
    SchemaMap,
    DatabaseOptions,
    TransactionOptions,
    Relationship,
    EntityAccessor,
    TypedAccessors,
    AugmentedEntity,
    UpdateBuilder,
    DeleteBuilder,
    InferSchema,
    EntityData,
    IndexDef,
    ChangeEvent,
    ProxyColumns,
    ColumnRef,
    ViewDefinition,
    ViewDefinitions,
    ReadonlyEntity,
    ReadonlyEntityAccessor,
    TypedReadonlyAccessors,
    ConflictMergeHelpers,
    ConflictExpression,
    ConflictColumn,
    UpsertConflictOptions,
    ProxyQueryResult,
    QueryCacheOptions,
    ASTNode,
    WhereCallback,
    SetCallback,
    TypedColumnProxy,
    FunctionProxy,
    Operators,
    MigrationBackup,
    MigrationColumnInfo,
    MigrationColumnMapping,
    MigrationConflictStrategy,
    MigrationPlan,
    MigrationPlanPreview,
    MigrationApplyResult,
} from 'sqlite-zod-orm';
```

For migration changes introduced in 4.0.0, see
[UPGRADING.md](UPGRADING.md).

## Contributing

sqlite-zod-orm is opinionated by design. Before proposing new features,
understand what it intentionally does **not** do:

| ❌ Don't add | Why |
|---|---|
| Tagged SQL templates | The whole point is "zero SQL" — `db.raw()` is the escape hatch |
| FTS5 wrapper | Wrapping it poorly is worse than not wrapping it — use `db.raw()` |
| Query middleware | `measure-fn` handles observability, `hooks` handle lifecycle |
| Cursor pagination | Offset pagination covers SQLite's single-process use case |
| Schema introspection API | Zod schemas are compile-time known — runtime reflection invites dynamic queries |
| Automatic destructive data mappings | Rebuilds preserve shared columns; use the migration CLI for explicit remapping |

**The rule:** if the query builder can already do it, don't add a new API surface for it.

## Development checks

Run `bun run check` for strict source TypeScript validation, the full runtime
suite, and a packed consumer check with `strictFunctionTypes: true` and
`skipLibCheck: false`.

The consumer verifies numeric FK fields, projected scalar reads, debug-mode
error propagation, and an independent measure-fn 5.3.1 import.

The ORM uses measure-fn 5.x and Zod 4.x at runtime. Development requires
TypeScript 7.x and current Bun types.

Published types remain generated in `dist/*.d.ts`, but declaration generation
performs full type checking: it does not use `noCheck` to conceal implementation
errors.

Regenerate `bun.lock` with `bun install` after upgrading dependencies.

## License

MIT

<!--
README 4.0.0 REVIEW NOTES
These notes document the release-review findings without adding maintainer
commentary to the rendered, developer-facing README.

1. Pitch
   - The previous "zero SQL" wording was too absolute: views use SQL definitions,
     and whereRaw(), db.raw(), and db.exec() accept SQL.
   - The new pitch scopes the promise to ordinary CRUD and fluent queries.
   - Bun, Zod, type safety, and relationships remain the primary differentiators.

2. Install and first query
   - Installation was already present, but Bun/Zod version requirements were
     buried near the end.
   - The original Quick Start only initialized a database. It did not insert
     a row, execute a query, or demonstrate relationship loading.
   - The new 15-line example demonstrates all three immediately.
   - The longer configuration example is preserved below the introduction.

3. Relationships
   - The original example declared posts.userId but documented post.user()
     and .with('user'). That conflicts with the stated accessor rule, which
     strips trailing "_id", not camelCase "Id".
   - The examples now use user_id, so the documented user() and
     .with('user') accessors are consistent.
   - The original relationship naming rules were separated from the
     Relationships section by other topics. They now appear together.
   - Multiple-FK inverse names, collision suffixes, self-relations, and
     explicit join FKs remain documented.

4. Migrations
   - Detailed reconstruction behavior previously appeared before any usable
     CRUD example.
   - The new Migrations section separates safe automatic behavior from
     operations that fail rather than silently changing data semantics.
   - Type changes on populated columns, ambiguous drop-plus-add operations,
     legacy CHECK/NOT NULL/ON CONFLICT constraints, differing FK actions,
     and broken triggers are called out.
   - The transaction, snapshot, index, trigger, view, FK validation,
     and locking facts are retained.
   - UPGRADING.md is linked for explicit upgrade guidance.

5. Reactivity and persistence
   - The previous README demonstrated proxy auto-persistence but did not
     distinguish this from reactive query subscriptions.
   - Startup change tracking was mentioned without a usage example.
   - The public entry point exports ChangeEvent as a type only; no
     standalone runtime ChangeEvent export exists.
   - No subscription API is invented from the entry point alone.
   - A concrete reactivity example remains a documentation gap if the
     Database instance exposes a supported subscription method.

6. Errors
   - Failure and rollback behavior was scattered across schema setup,
     relationship naming, and transaction documentation.
   - The new failure summary makes rollback, constraint validation,
     ambiguity rejection, lock timeouts, and non-retried callbacks visible.
   - Exact exception classes/messages and debugging examples remain
     undocumented; src/index.ts alone does not establish them.

7. Public exports and naming
   - Database, defineView, and z are valid named exports in src/index.ts.
   - db.raw(), db.exec(), db.diff(), db.migrator(), and generated table
     accessors are instance-level APIs, not named package exports.
   - The original README omitted the public migrator and CLI exports:
     createMigrator, DatabaseMigrator, and runCli.
   - The new Public API section documents the entry-point exports
     without claiming additional APIs.
   - SatiDB in the original Contributing introduction was inconsistent
     with the package name; it is corrected to sqlite-zod-orm.

8. Example consistency
   - Several examples intentionally reference fields and tables absent
     from the initial schema (role, orders, first, last, and others).
   - The new Configuration section explicitly identifies those snippets
     as examples requiring corresponding application schemas.
   - Existing feature behavior and examples are otherwise retained.
-->
