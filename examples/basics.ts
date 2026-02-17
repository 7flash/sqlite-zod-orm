/**
 * basics.ts — CRUD & Simple Queries
 *
 * Demonstrates the fundamental operations:
 *  - Schema definition with Zod validation
 *  - Insert, get, update, delete
 *  - Fluent select().where().orderBy()
 *  - Query operators ($gt, $in, $ne)
 *  - Defaults and computed fields
 *
 * Run: bun examples/basics.ts
 */
import { Database, z } from '../src/index';

// --- Schema ---

const UserSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    role: z.string().default('member'),
    score: z.number().int().default(0),
});

// --- Database ---

const db = new Database(':memory:', {
    users: UserSchema,
}, {
    indexes: { users: ['email', ['name', 'role']] },
});

// --- Insert ---

const alice = db.users.insert({ name: 'Alice', email: 'alice@example.com', role: 'admin', score: 100 });
const bob = db.users.insert({ name: 'Bob', email: 'bob@example.com', score: 75 });
const carol = db.users.insert({ name: 'Carol', email: 'carol@example.com', score: 42 });

console.log('Inserted:', alice.name, bob.name, carol.name);
console.log('Bob default role:', bob.role); // → 'member'

// --- Get ---

const found = db.users.get(1);
console.log('Get by ID:', found?.name); // → 'Alice'

const admin = db.users.get({ role: 'admin' });
console.log('Get by filter:', admin?.name); // → 'Alice'

// --- Update ---

alice.update({ score: 200 });
console.log('Updated score:', db.users.get(1)?.score); // → 200

// Fluent update
const affected = db.users.update({ score: 0 }).where({ role: 'member' }).exec();
console.log('Reset member scores:', affected, 'rows');

// --- Fluent Select ---

const topScorers = db.users.select()
    .where({ score: { $gt: 0 } })
    .orderBy('score', 'desc')
    .all();
console.log('Top scorers:', topScorers.map(u => `${u.name}: ${u.score}`));

// Operators
const nonAdmins = db.users.select()
    .where({ role: { $ne: 'admin' } })
    .all();
console.log('Non-admins:', nonAdmins.map(u => u.name));

const specific = db.users.select()
    .where({ name: { $in: ['Alice', 'Carol'] } })
    .all();
console.log('In-query:', specific.map(u => u.name));

// Count
const total = db.users.select().count();
console.log('Total users:', total);

// Single row
const first = db.users.select().orderBy('name', 'asc').get();
console.log('First alphabetically:', first?.name);

// --- Delete ---

db.users.delete(carol.id);
console.log('After delete, total:', db.users.select().count());

// --- Validation ---

try {
    db.users.insert({ name: '', email: 'bad', role: 'test', score: 0 });
} catch (e: any) {
    console.log('Validation error:', e.issues?.[0]?.message ?? e.message);
}

console.log('\n✅ basics.ts complete');
