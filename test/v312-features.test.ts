/**
 * v312-features.test.ts — Tests for v3.12 features
 *
 * Batch soft delete, restore(), onlyTrashed(), unique constraints,
 * schema introspection (tables, columns).
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    email: z.string(),
    score: z.number().default(0),
});

function createDb(opts: Record<string, any> = {}) {
    return new Database(':memory:', { users: UserSchema }, opts);
}

function seedUsers(db: ReturnType<typeof createDb>) {
    db.users.insert({ name: 'Alice', email: 'alice@co.com', score: 100 });
    db.users.insert({ name: 'Bob', email: 'bob@co.com', score: 50 });
    db.users.insert({ name: 'Carol', email: 'carol@co.com', score: 100 });
}

// ==========================================================================
// Batch soft delete
// ==========================================================================
describe('batch soft delete', () => {
    test('delete().where().exec() soft-deletes when softDeletes enabled', () => {
        const db = createDb({ softDeletes: true });
        seedUsers(db);
        (db.users as any).delete().where({ score: 100 }).exec();
        // Alice and Carol are soft-deleted, Bob remains
        const visible = db.users.select().all();
        expect(visible.length).toBe(1);
        expect(visible[0]!.name).toBe('Bob');
        // But they still exist in DB
        const all = db.users.select().withTrashed().all();
        expect(all.length).toBe(3);
        db.close();
    });

    test('delete().where().exec() hard-deletes when softDeletes disabled', () => {
        const db = createDb();
        seedUsers(db);
        (db.users as any).delete().where({ score: 100 }).exec();
        const all = db.users.select().all();
        expect(all.length).toBe(1);
        expect(all[0]!.name).toBe('Bob');
        // Hard deleted — not recoverable
        const raw = db.raw<any>('SELECT COUNT(*) as c FROM users');
        expect(raw[0]!.c).toBe(1);
        db.close();
    });
});

// ==========================================================================
// restore()
// ==========================================================================
describe('restore()', () => {
    test('restore(id) un-deletes a soft-deleted row', () => {
        const db = createDb({ softDeletes: true });
        const user = db.users.insert({ name: 'Alice', email: 'alice@co.com' });
        db.users.delete(user.id);
        expect(db.users.select().count()).toBe(0);
        db.users.restore(user.id);
        expect(db.users.select().count()).toBe(1);
        expect(db.users.select().get()!.name).toBe('Alice');
        db.close();
    });

    test('restore() throws without softDeletes', () => {
        const db = createDb();
        db.users.insert({ name: 'Test', email: 't@co.com' });
        expect(() => db.users.restore(1)).toThrow('softDeletes');
        db.close();
    });
});

// ==========================================================================
// onlyTrashed()
// ==========================================================================
describe('onlyTrashed()', () => {
    test('returns only soft-deleted rows', () => {
        const db = createDb({ softDeletes: true });
        seedUsers(db);
        db.users.delete(1); // soft-delete Alice
        const trashed = db.users.select().onlyTrashed().all();
        expect(trashed.length).toBe(1);
        expect(trashed[0]!.name).toBe('Alice');
        db.close();
    });

    test('onlyTrashed().count() counts only deleted rows', () => {
        const db = createDb({ softDeletes: true });
        seedUsers(db);
        db.users.delete(1);
        db.users.delete(2);
        expect(db.users.select().onlyTrashed().count()).toBe(2);
        expect(db.users.select().count()).toBe(1);
        db.close();
    });
});

// ==========================================================================
// Unique constraints
// ==========================================================================
describe('unique constraints', () => {
    test('unique constraint prevents duplicates', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            unique: { users: [['email']] },
        });
        db.users.insert({ name: 'Alice', email: 'alice@co.com' });
        expect(() => db.users.insert({ name: 'Bob', email: 'alice@co.com' }))
            .toThrow();
        db.close();
    });

    test('compound unique constraint', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            unique: { users: [['name', 'email']] },
        });
        db.users.insert({ name: 'Alice', email: 'alice@co.com' });
        // Same name, different email — OK
        db.users.insert({ name: 'Alice', email: 'alice2@co.com' });
        // Same name + email — fails
        expect(() => db.users.insert({ name: 'Alice', email: 'alice@co.com' }))
            .toThrow();
        db.close();
    });
});

// ==========================================================================
// Schema introspection
// ==========================================================================
describe('schema introspection', () => {
    test('tables() returns table names', () => {
        const db = createDb();
        const tables = db.tables();
        expect(tables).toContain('users');
        db.close();
    });

    test('columns() returns column info', () => {
        const db = createDb();
        const cols = db.columns('users');
        const names = cols.map(c => c.name);
        expect(names).toContain('id');
        expect(names).toContain('name');
        expect(names).toContain('email');
        expect(names).toContain('score');
        db.close();
    });

    test('columns() includes timestamp columns when enabled', () => {
        const db = createDb({ timestamps: true });
        const cols = db.columns('users');
        const names = cols.map(c => c.name);
        expect(names).toContain('createdAt');
        expect(names).toContain('updatedAt');
        db.close();
    });

    test('columns() includes deletedAt when softDeletes enabled', () => {
        const db = createDb({ softDeletes: true });
        const cols = db.columns('users');
        const names = cols.map(c => c.name);
        expect(names).toContain('deletedAt');
        db.close();
    });
});
