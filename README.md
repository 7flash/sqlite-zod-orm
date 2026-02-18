# sqlite-zod-orm

Type-safe SQLite ORM for Bun. Define schemas with Zod, get a fully-typed database with automatic relationships, lazy navigation, and zero SQL.

```bash
bun add sqlite-zod-orm
```

## Quick Start

```typescript
import { Database, z } from 'sqlite-zod-orm';

const db = new Database(':memory:', {
  users: z.object({
    name: z.string(),
    email: z.string().email(),
    role: z.string().default('member'),
  }),
});

const alice = db.users.insert({ name: 'Alice', email: 'alice@example.com', role: 'admin' });
const admin = db.users.select().where({ role: 'admin' }).get();  // single row
const all   = db.users.select().all();                           // all rows
```

---

## Defining Relationships

FK columns go in your schema. The `relations` config declares which FK points to which table:

```typescript
const AuthorSchema = z.object({ name: z.string(), country: z.string() });
const BookSchema   = z.object({ title: z.string(), year: z.number(), author_id: z.number().optional() });

const db = new Database(':memory:', {
  authors: AuthorSchema,
  books:   BookSchema,
}, {
  relations: {
    books: { author_id: 'authors' },
  },
});
```

`books: { author_id: 'authors' }` tells the ORM that `books.author_id` is a foreign key referencing `authors.id`. The ORM automatically:

- Adds `FOREIGN KEY (author_id) REFERENCES authors(id)` constraint
- Infers the inverse one-to-many `authors → books`
- Enables lazy navigation: `book.author()` and `author.books()`
- Enables fluent joins: `db.books.select().join(db.authors).all()`

The nav method name is derived by stripping `_id` from the FK column: `author_id` → `author()`.

---

## Querying — `select()` is the only path

All queries go through `select()`:

```typescript
// Single row
const user = db.users.select().where({ id: 1 }).get();

// All matching rows
const admins = db.users.select().where({ role: 'admin' }).all();

// All rows
const everyone = db.users.select().all();

// Count
const count = db.users.select().count();
```

### Operators

`$gt` `$gte` `$lt` `$lte` `$ne` `$in`

```typescript
const topScorers = db.users.select()
  .where({ score: { $gt: 50 } })
  .orderBy('score', 'desc')
  .limit(10)
  .all();
```

### `$or`

```typescript
const results = db.users.select()
  .where({ $or: [{ role: 'admin' }, { score: { $gt: 50 } }] })
  .all();
```

### Fluent Join

Auto-infers foreign keys from relationships:

```typescript
const rows = db.books.select('title', 'year')
  .join(db.authors, ['name', 'country'])
  .where({ year: { $gt: 1800 } })
  .orderBy('year', 'asc')
  .all();
// → [{ title: 'War and Peace', year: 1869, authors_name: 'Leo Tolstoy', ... }]
```

### `db.query()` — Proxy Query (SQL-like)

Full SQL-like control with destructured table aliases:

```typescript
const rows = db.query(c => {
  const { authors: a, books: b } = c;
  return {
    select: { author: a.name, book: b.title, year: b.year },
    join: [[b.author_id, a.id]],
    where: { [a.country]: 'Russia' },
    orderBy: { [b.year]: 'asc' },
  };
});
```

---

## Lazy Navigation

Relationship fields become callable methods on entities. The method name is the FK column with `_id` stripped:

```typescript
// belongs-to: book.author_id → book.author()
const book = db.books.select().where({ title: 'War and Peace' }).get()!;
const author = book.author();       // → { name: 'Leo Tolstoy', ... }

// one-to-many: author → books
const books = tolstoy.books();      // → [{ title: 'War and Peace' }, ...]

// Chain
const allByAuthor = book.author().books();
```

---

## CRUD

```typescript
// Insert (defaults fill in automatically)
const user = db.users.insert({ name: 'Alice', role: 'admin' });

// Insert with FK
const book = db.books.insert({ title: 'War and Peace', year: 1869, author_id: tolstoy.id });

// Read
const one   = db.users.select().where({ id: 1 }).get();
const some  = db.users.select().where({ role: 'admin' }).all();
const all   = db.users.select().all();
const count = db.users.select().count();

// Entity-level update
user.update({ role: 'superadmin' });

// Update by ID
db.users.update(1, { role: 'superadmin' });

// Fluent update with WHERE
db.users.update({ role: 'member' }).where({ role: 'guest' }).exec();

// Upsert
db.users.upsert({ name: 'Alice' }, { name: 'Alice', role: 'admin' });

// Delete
db.users.delete(1);
```

### Auto-Persist Proxy

Setting a property on an entity auto-updates the DB:

```typescript
const alice = db.users.select().where({ id: 1 }).get()!;
alice.score = 200;    // → UPDATE users SET score = 200 WHERE id = 1
```

---

## Schema Validation

Zod validates every insert and update at runtime:

```typescript
db.users.insert({ name: '', email: 'bad', age: -1 });  // throws ZodError
```

---

## Indexes

```typescript
const db = new Database(':memory:', schemas, {
  indexes: {
    users: ['email', ['name', 'role']],
    books: ['author_id', 'year'],
  },
});
```

---

## Reactivity — Three Ways to React to Changes

sqlite-zod-orm provides three reactivity mechanisms for different use cases:

| System | Detects | Scope | Overhead | Best for |
|---|---|---|---|---|
| **CRUD Events** | insert, update, delete | In-process, per table | Zero (synchronous) | Side effects, caching, logs |
| **Smart Polling** | insert, delete, update* | Any query result | Lightweight fingerprint check | Live UI, dashboards |
| **Change Tracking** | insert, update, delete | Per table or global | Trigger-based WAL | Cross-process sync, audit |

\* Smart polling detects UPDATEs automatically when `changeTracking` is enabled. Without it, only inserts and deletes are detected.

---

### 1. CRUD Events — `db.table.subscribe(event, callback)`

Synchronous callbacks fired immediately after each CRUD operation. Zero overhead; the callback runs inline.

```typescript
// Listen for new users
db.users.subscribe('insert', (user) => {
  console.log('New user:', user.name);   // fires on every db.users.insert(...)
});

// Listen for updates
db.users.subscribe('update', (user) => {
  console.log('Updated:', user.name, '→', user.role);
});

// Listen for deletes
db.users.subscribe('delete', (user) => {
  console.log('Deleted:', user.name);
});

// Stop listening
db.users.unsubscribe('update', myCallback);
```

**Use cases:**
- Invalidating a cache after writes
- Logging / audit trail
- Sending notifications
- Keeping derived data in sync (e.g., a counter table)

The database also extends Node's `EventEmitter`, so you can use `db.on()`:

```typescript
db.on('insert', (tableName, entity) => {
  console.log(`New row in ${tableName}:`, entity.id);
});
```

---

### 2. Smart Polling — `select().subscribe(callback, options)`

Query-level polling that watches *any query result* for changes. Instead of re-fetching all rows every tick, it runs a **lightweight fingerprint query** (`SELECT COUNT(*), MAX(id)`) with the same WHERE clause. The full query only re-executes when the fingerprint changes.

```typescript
// Watch for admin list changes, poll every second
const unsub = db.users.select()
  .where({ role: 'admin' })
  .orderBy('name', 'asc')
  .subscribe((admins) => {
    console.log('Admin list:', admins.map(a => a.name));
  }, { interval: 1000 });

// Stop watching
unsub();
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `interval` | `500` | Polling interval in milliseconds |
| `immediate` | `true` | Whether to fire the callback immediately with the current result |

**How the fingerprint works:**

```
┌─────────────────────────────────────┐
│  Every {interval}ms:                │
│                                     │
│  1. Run: SELECT COUNT(*), MAX(id)   │
│     FROM users WHERE role = 'admin' │
│                                     │  ← fast, no data transfer
│  2. Compare fingerprint to last     │
│                                     │
│  3. If changed → re-run full query  │  ← only when needed
│     and call your callback          │
└─────────────────────────────────────┘
```

**What it detects:**

| Operation | Without `changeTracking` | With `changeTracking` |
|---|---|---|
| INSERT | ✅ (MAX(id) increases) | ✅ |
| DELETE | ✅ (COUNT changes) | ✅ |
| UPDATE | ❌ (fingerprint unchanged) | ✅ (change sequence bumps) |

> **Tip:** Enable `changeTracking: true` if you need `.subscribe()` to react to UPDATEs.
> The overhead is minimal — one trigger per table that appends to a `_changes` log.

**Use cases:**
- Live dashboards (poll every 1-5s)
- Real-time chat message lists
- Auto-refreshing data tables
- Watching filtered subsets of data

---

### 3. Change Tracking — `changeTracking: true`

A trigger-based WAL (write-ahead log) that records every INSERT, UPDATE, and DELETE to a `_changes` table. This is the foundation for cross-process sync and audit trails.

```typescript
const db = new Database(':memory:', schemas, {
  changeTracking: true,
});
```

When enabled, the ORM creates:
- A `_changes` table: `(id, table_name, row_id, action, changed_at)`
- An index on `(table_name, id)` for fast lookups
- Triggers on each table for INSERT, UPDATE, and DELETE

**Reading changes:**

```typescript
// Get the current sequence number (latest change ID)
const seq = db.getChangeSeq();            // global
const seq = db.getChangeSeq('users');     // per table

// Get all changes since a sequence number
const changes = db.getChangesSince(0);    // all changes ever
const changes = db.getChangesSince(seq);  // new changes since seq

// Each change looks like:
// { id: 42, table_name: 'users', row_id: 7, action: 'UPDATE', changed_at: '2024-...' }
```

**Polling for changes (external sync pattern):**

```typescript
let lastSeq = 0;

setInterval(() => {
  const changes = db.getChangesSince(lastSeq);
  if (changes.length > 0) {
    lastSeq = changes[changes.length - 1].id;
    for (const change of changes) {
      console.log(`${change.action} on ${change.table_name} row ${change.row_id}`);
    }
  }
}, 1000);
```

**Use cases:**
- Syncing between processes (e.g., worker → main thread)
- Building an event-sourced system
- Replication to another database
- Audit logging with timestamps
- Powering smart polling UPDATE detection

---

### Choosing the Right System

```
Do you need to react to your own writes?
  → CRUD Events (db.table.subscribe)

Do you need to watch a query result set?
  → Smart Polling (select().subscribe)
  → Enable changeTracking if you need UPDATE detection

Do you need cross-process sync or audit?
  → Change Tracking (changeTracking: true + getChangesSince)
```

All three systems can be used together. `changeTracking` enhances smart polling automatically — no code changes needed.

---

## Examples & Tests

```bash
bun examples/example.ts    # comprehensive demo
bun test                    # 91 tests
```

---

## API Reference

| Method | Description |
|---|---|
| `new Database(path, schemas, options?)` | Create database with Zod schemas |
| **Querying** | |
| `db.table.select(...cols?).where(filter).get()` | Single row |
| `db.table.select(...cols?).where(filter).all()` | Array of rows |
| `db.table.select().count()` | Count rows |
| `db.table.select().join(db.other, cols?).all()` | Fluent join (auto FK) |
| `db.query(c => { ... })` | Proxy callback (SQL-like JOINs) |
| **Writing** | |
| `db.table.insert(data)` | Insert with validation |
| `db.table.update(id, data)` | Update by ID |
| `db.table.update(data).where(filter).exec()` | Fluent update |
| `db.table.upsert(match, data)` | Insert or update |
| `db.table.delete(id)` | Delete by ID |
| **Navigation** | |
| `entity.navMethod()` | Lazy navigation (FK name minus `_id`) |
| `entity.update(data)` | Update entity in-place |
| `entity.delete()` | Delete entity |
| **Reactivity** | |
| `db.table.subscribe(event, cb)` | CRUD events: `'insert'`, `'update'`, `'delete'` |
| `db.table.unsubscribe(event, cb)` | Remove CRUD event listener |
| `db.on(event, cb)` | EventEmitter: listen across all tables |
| `select().subscribe(cb, opts?)` | Smart polling (fingerprint-based) |
| `db.getChangeSeq(table?)` | Current change sequence number |
| `db.getChangesSince(seq, table?)` | Changes since sequence (change tracking) |

## License

MIT
