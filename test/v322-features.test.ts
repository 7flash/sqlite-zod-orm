/**
 * v322-features.test.ts — Tests for v3.22 features
 *
 * toSQL(), firstOrFail().
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    role: z.string().default('guest'),
    score: z.number().default(0),
});

// ==========================================================================
// toSQL
// ==========================================================================
describe('toSQL', () => {
    test('returns SQL and params for simple query', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const result = db.users.select().where({ role: 'admin' }).toSQL();
        expect(result.sql).toContain('SELECT');
        expect(result.sql).toContain('FROM');
        expect(result.sql).toContain('WHERE');
        expect(result.params).toContain('admin');
        db.close();
    });

    test('toSQL with multiple conditions', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const result = db.users.select()
            .where({ role: 'admin', score: { $gte: 50 } })
            .orderBy('name', 'asc')
            .limit(10)
            .toSQL();
        expect(result.sql).toContain('WHERE');
        expect(result.sql).toContain('ORDER BY');
        expect(result.sql).toContain('LIMIT');
        expect(result.params).toContain('admin');
        expect(result.params).toContain(50);
        db.close();
    });

    test('toSQL does not execute the query', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice' });

        // toSQL should not execute — delete should not happen
        db.users.select().where({ name: 'Alice' }).toSQL();
        expect(db.users.count()).toBe(1);
        db.close();
    });
});

// ==========================================================================
// firstOrFail
// ==========================================================================
describe('firstOrFail', () => {
    test('returns row when found', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice' });
        const user = db.users.select().where({ name: 'Alice' }).firstOrFail();
        expect(user.name).toBe('Alice');
        db.close();
    });

    test('throws when no row found', () => {
        const db = new Database(':memory:', { users: UserSchema });
        expect(() => {
            db.users.select().where({ name: 'Nobody' }).firstOrFail();
        }).toThrow('No matching row found');
        db.close();
    });
});
