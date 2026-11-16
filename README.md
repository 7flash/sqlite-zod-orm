# sqlite-zod-orm

Type-safe SQLite ORM for Bun — Zod schemas, fluent queries, auto relationships, zero SQL.

```bash
bun add sqlite-zod-orm
```

## Quick Start

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
        userId: z.number(),
    }),
}, {
    relations: { posts: { userId: 'users' } },
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

Tables are auto-created and auto-migrated from your Zod schemas. No SQL required.

Schema changes (including added fields) reconstruct affected tables in a
transaction. Each rebuild retains a `table_vN` data snapshot, preserves row IDs
and existing column values, initializes added nullable/defaulted fields, and
recreates indexes and triggers on the live table. Inline column `UNIQUE`
constraints are reconstructed as named unique indexes. Declared relationships,
incoming foreign-key references and existing views remain directed at the live
table. If a required field cannot be populated, an index cannot be recreated,
foreign keys fail validation, or a dependent view becomes invalid, initialization
rolls back instead of committing a partial migration. Historical snapshots are
available for explicit recovery through `db.migrator()`.

All startup schema work (tables, indexes, unique constraints, views and change
tracking) runs under `BEGIN IMMEDIATE`. SQLite waits for locks before WAL or schema
work; configure the wait with `{ busyTimeout: 10000 }` (milliseconds, default 5000;
zero disables waiting).

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

## Relationships

```typescript
// Navigation (lazy, proxy-based)
const post = db.posts.get(1);
post.user();         // → related user object
const user = db.users.get(1);
user.posts();        // → array of user's posts

// Eager loading (no N+1)
db.posts.select().with('user').all();
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

## Batch Mutations

```typescript
db.users.select().where({ role: 'guest' }).updateAll({ role: 'member' }); // → affected count
db.users.select().where({ role: 'spam' }).deleteAll();                    // → deleted count
```

## Pagination

```typescript
const page = db.users.select().orderBy('name').paginate(1, 20);
// { data: [...], total: 42, page: 1, perPage: 20, pages: 3 }
```

## Select Type Narrowing

```typescript
const names = db.users.select('name', 'email').all();
names[0].name;  // ✅ string
names[0].score; // ❌ TypeScript error — not selected
```

## Computed Getters

```typescript
const db = new Database(':memory:', { users: UserSchema }, {
    computed: {
        users: { fullName: (u) => `${u.first} ${u.last}` },
    },
});
user.fullName; // 'Alice Smith' — recomputes on access
```

### Relationship accessor names

Navigation accessors strip a trailing `_id` (`author_id` becomes `author()`).
If that name is a stored schema field or an entity method (`id`, `update`,
`delete`), `Relation` is appended until the name is available. For example,
`agentRef` stays numeric and its parent is accessed with `agentRefRelation()`.
Inverse accessors follow the same rule: a stored `books` field is preserved
and children are accessed with `booksRelation()`.

When **multiple foreign keys** connect the same child table to one parent,
**every** inverse is named `<childTable>By<FK>` (FK in PascalCase, converting
underscores to word boundaries), independent of declaration order. For example,
`grants.authorRef`, `grants.agentRef` and `grants.auditorRef` referencing
`agents` produce `agents.grantsByAuthorRef()`, `grantsByAgentRef()` and
`grantsByAuditorRef()`; each returns only children matching its own FK. A
self-reference is also FK-qualified: `nodes.nodes_id → nodes` yields forward
`nodes()` and inverse `nodesByNodesId()`. If an inverse name conflicts with a
stored field, generated field, method or forward accessor, append `Relation`
until free. Conflicting forward names are rejected. `.with()` uses the same
inverse names (and yields arrays instead of lazy functions). Automatic joins
are rejected when more than one FK can connect the selected tables; supply
the FK explicitly with `.join('agents', 'authorRef', ['name'])`.

## Cascade Deletes

```typescript
const db = new Database(':memory:', { authors: AuthorSchema, books: BookSchema }, {
    relations: { books: { author_id: 'authors' } },
    cascade: { authors: ['books'] },
});
db.authors.delete(1); // → books with author_id=1 also deleted
```

## Transactions

```typescript
db.transaction(() => {
    db.users.insert({ name: 'Alice' });
    db.orders.insert({ userId: 1, amount: 100 });
}); // auto-commits; rolls back on error
```

Transactions are synchronous and default to `BEGIN IMMEDIATE`, acquiring the write
lock before the callback reads. Lock contention waits for `busyTimeout`; once that
expires, SQLite throws. Callbacks are never automatically replayed. Nested
transactions use savepoints. For read-only work or deliberate alternative locking,
pass `db.transaction(work, { mode: 'deferred' })` or `{ mode: 'exclusive' }`.

## Data Import / Export

```typescript
const backup = db.dump();                      // export all tables as JSON
db.load(backup);                               // restore (truncates first)
db.load(backup, { append: true });             // restore without truncating
db.seed({ users: [{ name: 'Test User' }] });   // additive fixture seeding
```

## Schema Diffing

```typescript
const diff = db.diff();
// { users: { added: ['bio'], removed: ['legacy'], typeChanged: [] } }
```

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

Views are created on startup and recreated automatically when the definition changes. View accessors are read-only.

## Raw SQL

```typescript
db.raw<User>('SELECT * FROM users WHERE score > ?', 50);
db.exec('UPDATE users SET score = 0 WHERE role = ?', 'guest');
```

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

## Contributing

SatiDB is opinionated by design. Before proposing new features, understand what it intentionally does **not** do:

| ❌ Don't add | Why |
|---|---|
| Tagged SQL templates | The whole point is "zero SQL" — `db.raw()` is the escape hatch |
| FTS5 wrapper | Wrapping it poorly is worse than not wrapping it — use `db.raw()` |
| Query middleware | `measure-fn` handles observability, `hooks` handle lifecycle |
| Cursor pagination | Offset pagination covers SQLite's single-process use case |
| Schema introspection API | Zod schemas are compile-time known — runtime reflection invites dynamic queries |
| Automatic destructive data mappings | Rebuilds preserve shared columns; use the migration CLI for explicit remapping |

**The rule:** if the query builder can already do it, don't add a new API surface for it.

## Requirements

- **Bun** ≥ 1.0 (uses `bun:sqlite` native bindings)
- **Zod** ≥ 4.6.7

## Development checks

Run `bun run check` for strict source TypeScript validation, the full runtime
suite, and a packed consumer check with `strictFunctionTypes: true` and
`skipLibCheck: false`. The consumer verifies numeric FK fields, projected scalar
reads, debug-mode error propagation, and an independent measure-fn 5.3.1 import.

The ORM uses measure-fn 5.x and Zod 4.x at runtime. Development requires
TypeScript 7.x and current Bun types. Published types remain generated in
`dist/*.d.ts`, but declaration generation performs full type checking: it does
not use `noCheck` to conceal implementation errors. Regenerate `bun.lock` with
`bun install` after upgrading dependencies.

## License

MIT
