/**
 * v3.26 feature tests — Prepared statement caching + pagination
 */
import { describe, test, expect } from 'bun:test';
import { Database } from '../src';
import { z } from 'zod';
import { tmpdir } from 'os';
import { join } from 'path';

function createDb(opts: Record<string, any> = {}) {
    return new Database(join(tmpdir(), `satidb-v326-${Date.now()}-${Math.random().toString(36).slice(2)}.db`), {
        users: z.object({
            name: z.string(),
            email: z.string(),
            age: z.number().optional(),
        }),
    }, opts);
}

// ==========================================================================
// Prepared Statement Caching
// ==========================================================================
describe('prepared statements', () => {
    test('repeated inserts reuse cached statements', () => {
        const db = createDb();
        // Insert multiple rows — should all use the same cached statement
        for (let i = 0; i < 100; i++) {
            db.users.insert({ name: `User ${i}`, email: `user${i}@test.com` });
        }
        expect(db.users.count()).toBe(100);
        db.close();
    });

    test('repeated selects reuse cached statements', () => {
        const db = createDb();
        db.users.insert({ name: 'Alice', email: 'alice@test.com' });
        db.users.insert({ name: 'Bob', email: 'bob@test.com' });

        // Same query pattern multiple times
        for (let i = 0; i < 50; i++) {
            const user = db.users.select().where({ name: 'Alice' }).get();
            expect(user!.name).toBe('Alice');
        }
        db.close();
    });

    test('prepared statements survive mixed operations', () => {
        const db = createDb();

        // Insert
        const alice = db.users.insert({ name: 'Alice', email: 'alice@test.com' });

        // Select
        const found = db.users.select().where({ id: alice.id }).get();
        expect(found!.name).toBe('Alice');

        // Update
        db.users.update(alice.id, { name: 'Alicia' });

        // Select again (reuses cached statement)
        const updated = db.users.select().where({ id: alice.id }).get();
        expect(updated!.name).toBe('Alicia');

        // Delete
        db.users.delete(alice.id);
        expect(db.users.count()).toBe(0);

        db.close();
    });

    test('raw queries use cached statements', () => {
        const db = createDb();
        db.users.insert({ name: 'Alice', email: 'a@b.com' });

        // Same raw query multiple times
        for (let i = 0; i < 10; i++) {
            const rows = db.raw('SELECT * FROM "users" WHERE name = ?', 'Alice');
            expect(rows.length).toBe(1);
        }
        db.close();
    });
});

// ==========================================================================
// Pagination
// ==========================================================================
describe('pagination', () => {
    test('paginate returns correct structure', () => {
        const db = createDb();
        for (let i = 0; i < 25; i++) {
            db.users.insert({ name: `User ${i}`, email: `user${i}@test.com` });
        }

        const page1 = db.users.select().paginate(1, 10);
        expect(page1.data.length).toBe(10);
        expect(page1.total).toBe(25);
        expect(page1.page).toBe(1);
        expect(page1.perPage).toBe(10);
        expect(page1.pages).toBe(3);
        db.close();
    });

    test('paginate middle page', () => {
        const db = createDb();
        for (let i = 0; i < 25; i++) {
            db.users.insert({ name: `User ${String(i).padStart(2, '0')}`, email: `user${i}@test.com` });
        }

        const page2 = db.users.select().orderBy('name').paginate(2, 10);
        expect(page2.data.length).toBe(10);
        expect(page2.data[0]!.name).toBe('User 10');
        expect(page2.page).toBe(2);
        db.close();
    });

    test('paginate last page with partial results', () => {
        const db = createDb();
        for (let i = 0; i < 25; i++) {
            db.users.insert({ name: `User ${i}`, email: `user${i}@test.com` });
        }

        const page3 = db.users.select().paginate(3, 10);
        expect(page3.data.length).toBe(5);
        expect(page3.pages).toBe(3);
        db.close();
    });

    test('paginate empty table', () => {
        const db = createDb();
        const result = db.users.select().paginate(1, 10);
        expect(result.data.length).toBe(0);
        expect(result.total).toBe(0);
        expect(result.pages).toBe(0);
        db.close();
    });

    test('paginate with where clause', () => {
        const db = createDb();
        for (let i = 0; i < 30; i++) {
            db.users.insert({ name: `User ${i}`, email: `user${i}@test.com`, age: i % 2 === 0 ? 20 : 30 });
        }

        const result = db.users.select().where({ age: 20 }).paginate(1, 5);
        expect(result.total).toBe(15);
        expect(result.data.length).toBe(5);
        expect(result.pages).toBe(3);
        db.close();
    });

    test('paginate defaults (page=1, perPage=20)', () => {
        const db = createDb();
        for (let i = 0; i < 25; i++) {
            db.users.insert({ name: `User ${i}`, email: `user${i}@test.com` });
        }

        const result = db.users.select().paginate();
        expect(result.data.length).toBe(20);
        expect(result.perPage).toBe(20);
        expect(result.pages).toBe(2);
        db.close();
    });
});
