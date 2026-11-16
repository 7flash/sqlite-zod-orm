---
name: sqlite-zod-orm
description: Type-safe SQLite ORM for Bun with Zod schemas, fluent CRUD, relationships, transactions, and schema synchronization. Ordinary queries need no SQL; views, whereRaw, raw, and exec accept SQL.
---

# sqlite-zod-orm (4.0)

Use `sqlite-zod-orm` for type-safe SQLite persistence in Bun. Tables are defined with Zod; entities have write-through persistence, and queries support fluent filters and relationships. **SQL is optional for ordinary CRUD, not forbidden or eliminated.**

```bash
bun add sqlite-zod-orm
```

Requires Bun >= 1.0 and Zod >= 4.6.7 (Zod 4.x). The package uses `bun:sqlite` and `measure-fn` 5.x.

## 4.0 rules — read before changing schemas or relationships

- **Startup may rebuild tables.** `new Database(...)` synchronizes schemas transactionally, reconstructing affected tables rather than simply adding columns. It retains row IDs and shared values, recreates indexes and triggers, checks foreign keys and dependent views, and keeps `table_vN` snapshots accessible through `db.migrator()`. Failed initialization rolls back; a rebuild is not an automatic data-conversion strategy.
- **Migrate populated type changes explicitly.** A changed declared SQL type on a column containing values fails with `Cannot automatically change type of populated column "<table>.<column>" ...; use an explicit data-conversion migration.` Validate and convert the data **before** ORM initialization.
- **Migrate drop-plus-add / renames explicitly.** Removing a populated column while adding another fails with `Cannot automatically drop populated column "<table>.<column>" while adding "<new>"; use an explicit column-mapping migration.` Use `ALTER TABLE ... RENAME COLUMN ...` for a real rename, or an explicit backfill/rebuild for a transformation. Do not expect column names to be mapped automatically.
- **Preserve constraints and FK semantics.** Rebuilds reject legacy `CHECK`, `NOT NULL`, or `ON CONFLICT` rules that cannot be recreated (`Cannot automatically rebuild ... legacy CHECK|ON CONFLICT|NOT NULL constraint/policy cannot be recreated`) and outgoing FKs with different targets or `ON DELETE`/`ON UPDATE` actions (`Cannot automatically rebuild ... outgoing foreign keys ... differ`). Write an explicit constraint-preserving / FK migration instead; a unique index need not preserve `UNIQUE ON CONFLICT IGNORE` behavior.
- **Required fields, indexes, triggers, and views are validated.** A new required field on existing rows needs a valid default or explicit backfill (`Cannot populate required column ...`). Unreconstructable inline/unnamed indexes, name conflicts, broken dependent triggers (`Invalid trigger "<trigger>": no such column: <column>`), invalid views, or FK violations abort initialization. Update triggers that reference renamed columns; validate view definitions and `INSTEAD OF` triggers together.
- **Ambiguous automatic joins throw.** When two tables can join through multiple FKs, `.join('agents')` throws `Ambiguous automatic join ...`. Specify the FK: `.join('agents', 'authorRef', ['name'])`. This also matters for self-references.
- **Multiple FKs produce qualified inverse accessors.** If `grants.authorRef`, `grants.agentRef`, and `grants.auditorRef` all point to `agents`, their inverse methods are `grantsByAuthorRef()`, `grantsByAgentRef()`, and `grantsByAuditorRef()`; use those exact names in `.with(...)` too. See relationship naming rules below.

**Upgrade procedure:** Back up the database; test against realistic data. Run explicit SQL/data migrations while the app is stopped and **before** `new Database(...)`. Preserve all original columns, keys, constraints, indexes, triggers and references in manual table rebuilds; run `PRAGMA foreign_key_check`. Compare FK actions with a fresh 4.0 database, validate queries and generated accessor names, then run `bunx tsc --noEmit` and tests. Startup uses `BEGIN IMMEDIATE`; `{ busyTimeout: 10000 }` changes the default 5000 ms lock wait. Transactions are not automatically retried. An invalid post-rebuild FK raises `Schema sync would leave foreign key violations`.

For example, to rename a populated `users.full_name` column to `displayName` in an **existing** database, run this one-time migration before loading the new Zod schema (adapt names and error handling to your deployment):

```typescript
import { Database as SQLite } from 'bun:sqlite';

const sqlite = new SQLite('app.db');
sqlite.exec('PRAGMA foreign_keys = OFF');
try {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec('ALTER TABLE users RENAME COLUMN full_name TO displayName');
    const violations = sqlite.query('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error(`FK violations: ${JSON.stringify(violations)}`);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
} finally {
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.close();
}
// Only now construct sqlite-zod-orm with a schema using displayName.
```

For a type conversion or modified FK action, explicitly rebuild the real table and preserve dependent schema objects; a rename alone is insufficient.

## 1. Schemas and configuration

```typescript
import { Database, z } from 'sqlite-zod-orm';

const db = new Database('app.db', {
  users: z.object({
    name: z.string(),
    email: z.string().email(),
    role: z.string().default('member'),
    score: z.number().int().default(0),
  }),
  posts: z.object({
    title: z.string(),
    body: z.string(),
    published: z.boolean().default(false),
    user_id: z.number(),
  }),
}, {
  relations: { posts: { user_id: 'users' } },
  indexes: { users: ['role'], posts: ['user_id', 'published'] },
  unique: { users: [['email']] },
});
```

`'app.db'` persists data; `':memory:'` is ephemeral. FK columns must exist in their Zod schemas. A `relations` entry maps a child FK to a table name in the schema map. `.default(...)` supplies insert values. `indexes` configures indexes; `unique` configures single/composite uniqueness. Schema additions can trigger reconstruction, not just `ALTER TABLE ADD COLUMN`.

Optional database settings (supply at construction): `{ timestamps: true, softDeletes: true, wal: false, busyTimeout: 10000, debug: true }`. WAL is on by default. Examples below use the `db` above unless they construct their own database; fields/tables not in that schema must be declared before use.

## 2. CRUD and entities

```typescript
const alice = db.users.insert({ name: 'Alice', email: 'alice@co.com' });
// alice.id is generated; alice.role === 'member'; alice.score === 0
const post = db.posts.insert({ title: 'Hello', body: '...', user_id: alice.id });
const more = db.users.insertMany([
  { name: 'Bob', email: 'bob@co.com' },
  { name: 'Carol', email: 'carol@co.com' },
]);

const byId = db.users.get(alice.id);                      // row or null
const found = db.users.select().where({ id: alice.id }).get();
const first = db.users.select().where({ role: 'member' }).first();
const all = db.users.select().all();
const exists = db.users.select().where({ role: 'admin' }).exists();

db.users.update(alice.id, { role: 'admin' });
alice.update({ role: 'member' });
alice.score = 200;                                       // proxy auto-persists

db.users.upsert(
  { email: 'alice@co.com' },
  { name: 'Alice', email: 'alice@co.com', role: 'admin' },
);
db.users.upsertMany([{ id: alice.id, name: 'Alice', email: 'alice@co.com' }], 'id');
const { entity, created } = db.users.findOrCreate(
  { email: 'dave@co.com' },
  { name: 'Dave', email: 'dave@co.com', role: 'member' },
);

// Delete by id or entity; use select().where() for batch mutations.
const temporary = db.posts.insert({ title: 'Temp', body: '', user_id: alice.id });
db.posts.delete(temporary.id); // alternatively: temporary.delete();
```

Zod validates inserts/updates and applies defaults. Proxy property assignments persist immediately; no `.save()` call is needed. `insertMany` is transactional. `created` reports whether `findOrCreate` inserted a row.

## 3. Fluent queries and projections

```typescript
const top = db.users.select()
  .where({ score: { $gt: 50 }, role: { $ne: 'banned' } })
  .orderBy('score', 'DESC').limit(10).all();
const members = db.users.select().where({ role: { $in: ['member', 'admin'] } }).all();
const similar = db.users.select().where({ name: { $like: '%Ali%' } }).all();
const excluded = db.users.select().where({ role: { $notIn: ['banned'] } }).all();
const range = db.users.select().where({ score: { $between: [10, 100] } }).all();
const either = db.users.select()
  .where({ $or: [{ role: 'admin' }, { score: { $gte: 100 } }] }).all();
const page2 = db.users.select().orderBy('name', 'asc').limit(20).offset(20).all();
const names = db.users.select('name', 'email').all(); // only these fields typed
// names[0].score is a TypeScript error; filtering can still use other columns.

const ids = db.posts.select('user_id');
const authors = db.users.select().whereIn('id', ids).all(); // subquery
const named = db.users.select().whereIn('name', ['Alice', 'Bob']).all();
const other = db.users.select().whereNotIn('id', [1, 2]).all();
const firstOrError = db.users.select().where({ id: alice.id }).firstOrFail();
const justNames = db.users.select().pluck('name'); // flat string[]
```

Operators: `$gt`, `$gte`, `$lt`, `$lte`, `$ne`, `$in`, `$notIn`, `$like`, `$between`, `$isNull`, `$isNotNull` (NULL operators require a nullable column). `.select('name', 'email')` narrows `.all()`, `.get()`, `.first()`, and `.paginate()` results. `.firstOrFail()` throws if no row matches.

```typescript
const total = db.users.count();
const activeCount = db.users.select().where({ role: 'admin' }).count();
const sum = db.users.select().sum('score');
const avg = db.users.select().avg('score');
const min = db.users.select().min('score');
const max = db.users.select().max('score');
const grouped = db.users.select('role').groupBy('role').countGrouped();
const popular = db.users.select('role').groupBy('role')
  .having({ 'COUNT(*)': { $gt: 5 } }).raw().all();
const distinct = db.users.select('score').distinct().raw().all();
const page = db.users.select().orderBy('name').paginate(2, 20);
// page: { data, total, page, perPage, pages }; offset pagination

const base = db.users.select().where({ score: { $gte: 10 } });
const high = base.clone().where({ role: 'admin' });
const low = base.clone().where({ role: 'member' });
const compiled = high.toSQL(); // { sql, params }; does not execute
```

## 4. Relationships, joins, and eager loading

For `posts.user_id -> users`, the forward accessor strips trailing `_id`, and the default inverse is the child table name:

```typescript
post.user();          // related parent, lazy
alice.posts();        // related children, lazy
const eagerPosts = db.posts.select().with('user').all();
eagerPosts[0].user;   // loaded related user property, not a call
const eagerUsers = db.users.select().with('posts').all();
eagerUsers[0].posts;  // loaded child array; avoids N+1 queries

const joined = db.posts.select('title', 'published')
  .join('users', 'user_id', ['name', 'email'])
  .where({ published: true }).all();
// joined fields are prefixed: users_name, users_email
```

**Naming:** Only a trailing `_id` is stripped: `author_id -> author()`. A camelCase `userId` column does **not** produce `user()`; its stored field occupies `userId`, so navigation is `userIdRelation()`. A stored field or method collision appends `Relation` until a free accessor name is found. Invalid/irresolvable forward accessor collisions and unknown relation target tables are rejected at initialization.

With **multiple child FKs to one parent**, *every* inverse accessor includes `By<FK>` (PascalCase, underscores create word boundaries), regardless of declaration order:

```typescript
const graph = new Database(':memory:', {
  agents: z.object({ name: z.string() }),
  grants: z.object({
    authorRef: z.number(), agentRef: z.number(), auditorRef: z.number(),
  }),
}, {
  relations: {
    grants: { authorRef: 'agents', agentRef: 'agents', auditorRef: 'agents' },
  },
});
const agent = graph.agents.insert({ name: 'A' });
const grant = graph.grants.insert({
  authorRef: agent.id, agentRef: agent.id, auditorRef: agent.id,
});
agent.grantsByAuthorRef();
agent.grantsByAgentRef();
agent.grantsByAuditorRef();
grant.agentRef;           // numeric FK column
grant.agentRefRelation(); // parent entity; avoids stored-field collision
graph.agents.select().with('grantsByAuthorRef').all();
graph.grants.select().join('agents', 'authorRef', ['name']).all();
// .join('agents') is ambiguous and throws.
```

For a self-relation `nodes.nodes_id -> nodes`, accessors are `nodes()` and `nodesByNodesId()`. Eager loading uses these same names. Prefer explicit-FK joins where there is any potential ambiguity. Use `.with(...)` for related rows without N+1 queries; don't cast filter keys to `any` to pretend relation properties are stored columns.

For custom multi-table selections, the proxy query API supports column references:

```typescript
const proxyRows = db.query(c => {
  const { users: u, posts: p } = c;
  return {
    select: { author: u.name, title: p.title },
    join: [[p.user_id, u.id]],
    where: { [u.role]: 'admin' },
    orderBy: { [p.title]: 'asc' },
    limit: 10,
  };
});
```

## 5. Mutations, transactions, and lifecycle hooks

```typescript
const updated = db.users.select().where({ role: 'member' })
  .updateAll({ role: 'admin' }); // affected row count
const deleted = db.users.select().where({ role: 'banned' }).deleteAll();
const increments = db.users.select().where({ id: alice.id }).increment('score', 10);
db.users.select().where({ id: alice.id }).decrement('score', 5);
// increment/decrement are atomic; default increment is 1.

const result = db.transaction(() => {
  const user = db.users.insert({ name: 'Eve', email: 'eve@co.com' });
  const post = db.posts.insert({ title: 'First', body: '...', user_id: user.id });
  return { user, post };
});
// Synchronous; commits on success, rolls back on error; nested calls use savepoints.
// db.transaction(work, { mode: 'deferred' });
// db.transaction(work, { mode: 'exclusive' });
```

Transactions use `BEGIN IMMEDIATE` by default, do not replay callbacks, and throw on lock timeouts. Hooks are configured per table; `beforeUpdate` receives **(id, data)**, not `(data, id)`:

```typescript
const hookedDb = new Database(':memory:', {
  users: z.object({ name: z.string() }),
}, {
  hooks: { users: {
    beforeInsert: (data) => ({ ...data, name: data.name.trim() }),
    afterInsert: (entity) => { /* audit entity.id */ },
    beforeUpdate: (id, data) => ({ ...data, name: data.name.trim() }),
    afterUpdate: (entity) => { /* audit entity.id */ },
    beforeDelete: (id) => true, // return false to cancel
    afterDelete: (id) => { /* audit deletion */ },
  } },
});
```

Hooks cover insert, insertMany, update, and hard/soft delete paths; before hooks may transform data or cancel deletes as shown.

## 6. Optional table features

**Timestamps and soft deletes:** Enable with `{ timestamps: true, softDeletes: true }`. Inserts set `createdAt`/`updatedAt` (ISO timestamps); updates bump `updatedAt`. Deletion sets `deletedAt` rather than removing the row. Selects omit soft-deleted rows unless requested:

```typescript
const softDb = new Database(':memory:', {
  users: z.object({ name: z.string() }),
}, { softDeletes: true, timestamps: true });
const softUser = softDb.users.insert({ name: 'Alice' });
softUser.createdAt; softUser.updatedAt;
softDb.users.delete(softUser.id);      // sets deletedAt
softDb.users.select().all();           // excludes deleted
softDb.users.select().withTrashed().all(); // includes deleted
softDb.users.select().onlyTrashed().all(); // deleted only
softDb.users.restore(softUser.id);     // clears deletedAt
```

**Cascade deletes:** `{ relations: { books: { author_id: 'authors' } }, cascade: { authors: ['books'] } }` deletes matching books when an author is deleted. With soft deletes, children are soft-deleted too. Include both tables and `author_id` in the actual schema.

**JSON fields:** Zod objects and arrays stored in columns serialize to JSON text and deserialize on reads:

```typescript
const jsonDb = new Database(':memory:', {
  configs: z.object({
    name: z.string(),
    settings: z.object({ theme: z.string(), notifications: z.boolean() }),
    tags: z.array(z.string()).default([]),
  }),
});
const config = jsonDb.configs.insert({
  name: 'one', settings: { theme: 'dark', notifications: true },
});
config.settings.theme; // 'dark'
config.tags;           // []
```

**Computed getters:** Define virtual fields under `computed`, recomputed on access (the stored schema must define the referenced fields):

```typescript
const people = new Database(':memory:', {
  users: z.object({ first: z.string(), last: z.string(), score: z.number() }),
}, {
  computed: { users: {
    fullName: (u) => `${u.first} ${u.last}`,
    isVip: (u) => u.score > 100,
  } },
});
const person = people.users.insert({ first: 'Alice', last: 'Smith', score: 0 });
person.fullName; // 'Alice Smith'
person.score = 200;
person.isVip; // true
```

## 7. Typed views and SQL escape hatches

```typescript
import { defineView } from 'sqlite-zod-orm';

const reports = new Database(':memory:', {
  users: z.object({ name: z.string(), score: z.number() }),
}, {
  views: {
    high_scores: defineView(z.object({
      name: z.string(), score: z.number(),
    }), `SELECT name, score FROM users WHERE score >= 50`),
  },
});
reports.high_scores.select().all(); // typed, read-only view rows
reports.views();                    // ['high_scores']

const rawRows = db.raw<{ name: string }>(
  'SELECT name FROM users WHERE score > ?', 50,
);
db.exec('UPDATE users SET score = ? WHERE name = ?', 99, 'Alice');
const rawFilter = db.users.select()
  .where({ role: 'admin' })
  .whereRaw('score > ?', [50]).all();
```

Views are SQL-backed, read-only, and recreated when definitions change; invalid dependent views can abort migration. `whereRaw`, `db.raw`, and `db.exec` **take SQL**. Use the fluent builder for ordinary CRUD; parameterize SQL values instead of interpolating user input.

## 8. Introspection, backups, and debugging

```typescript
db.tables();          // application table names
db.columns('users');  // SQLite column metadata
db.diff();            // { users: { added: [...], removed: [...], typeChanged: [...] } }
const backup = db.dump();
db.load(backup);                       // replaces existing table data
// db.load(otherBackup, { append: true }); // alternative: adds without truncating
db.seed({ users: [{ name: 'Test', email: 'test@co.com' }] }); // additive fixtures
db.close();                           // release SQLite handle
```

`debug: true` enables SQL/query diagnostics and `measure-fn` instrumentation; off by default. Prepared statements are cached per database instance and released on `close()`. Startup installs change tracking, but proxy write-through persistence is **not** a live-query subscription; do not assume an undocumented subscription method. For explicit schema recovery/migrations use `db.migrator()` or the exported `createMigrator`, `DatabaseMigrator`, and `runCli` facilities, and consult `UPGRADING.md` before 3.x -> 4.0 upgrades.
