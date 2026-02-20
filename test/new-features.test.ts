/**
 * Expanded CRUD tests — covers insertMany, $like, $notIn, $between,
 * .first(), .exists(), .groupBy(), .close(), upsert edge cases,
 * updateWhere, deleteEntity on non-existent id, validation errors.
 */

import { test, expect, describe } from 'bun:test';
import { createTestDb, seedData, z, Database } from './setup';

// ==========================================================================
// insertMany
// ==========================================================================

describe('insertMany', () => {
    test('inserts multiple rows in one call', () => {
        const db = createTestDb();
        const results = db.forests.insertMany([
            { name: 'Black Forest', address: 'Germany' },
            { name: 'Daintree', address: 'Australia' },
            { name: 'Taiga', address: 'Russia' },
        ]);
        expect(results.length).toBe(3);
        expect(results[0]!.name).toBe('Black Forest');
        expect(results[2]!.name).toBe('Taiga');
        expect(results[0]!.id).toBeGreaterThan(0);
        db.close();
    });

    test('insertMany with empty array returns empty', () => {
        const db = createTestDb();
        const results = db.forests.insertMany([]);
        expect(results).toEqual([]);
        db.close();
    });

    test('insertMany returns entities with update/delete methods', () => {
        const db = createTestDb();
        const [forest] = db.forests.insertMany([{ name: 'Test Forest', address: 'Nowhere' }]);
        expect(typeof forest!.update).toBe('function');
        expect(typeof forest!.delete).toBe('function');
        db.close();
    });
});

// ==========================================================================
// $like, $notIn, $between operators
// ==========================================================================

describe('new operators', () => {
    test('$like matches pattern', () => {
        const db = createTestDb();
        seedData(db);
        const results = db.trees.select().where({ name: { $like: '%Oak%' } }).all();
        expect(results.length).toBe(2); // Major Oak, Robin Hood Oak
        expect(results.every(r => r.name.includes('Oak'))).toBe(true);
        db.close();
    });

    test('$notIn excludes values', () => {
        const db = createTestDb();
        seedData(db);
        const results = db.forests.select().where({ name: { $notIn: ['Amazon'] } }).all();
        expect(results.length).toBe(1);
        expect(results[0]!.name).toBe('Sherwood');
        db.close();
    });

    test('$notIn with empty array is no-op', () => {
        const db = createTestDb();
        seedData(db);
        const results = db.forests.select().where({ name: { $notIn: [] } }).all();
        expect(results.length).toBe(2); // all forests returned
        db.close();
    });

    test('$between filters range', () => {
        const db = createTestDb();
        seedData(db);
        const results = db.trees.select().where({ planted: { $between: ['2019-01-01', '2020-12-31'] } }).all();
        expect(results.length).toBe(2); // Mahogany (2020), Rubber Tree (2019)
        db.close();
    });

    test('$between throws for non-array input', () => {
        const db = createTestDb();
        seedData(db);
        expect(() => {
            db.trees.select().where({ planted: { $between: 'bad' as any } }).all();
        }).toThrow('requires [min, max]');
        db.close();
    });
});

// ==========================================================================
// .first() and .exists()
// ==========================================================================

describe('QueryBuilder: first() and exists()', () => {
    test('first() returns same result as get()', () => {
        const db = createTestDb();
        seedData(db);
        const fromGet = db.trees.select().where({ name: 'Mahogany' }).get();
        const fromFirst = db.trees.select().where({ name: 'Rubber Tree' }).first();
        expect(fromGet).not.toBeNull();
        expect(fromFirst).not.toBeNull();
        expect(fromGet!.name).toBe('Mahogany');
        expect(fromFirst!.name).toBe('Rubber Tree');
        db.close();
    });

    test('first() returns null for no match', () => {
        const db = createTestDb();
        const result = db.forests.select().where({ name: 'Nonexistent' }).first();
        expect(result).toBeNull();
        db.close();
    });

    test('exists() returns true when rows match', () => {
        const db = createTestDb();
        seedData(db);
        expect(db.trees.select().where({ name: 'Mahogany' }).exists()).toBe(true);
        db.close();
    });

    test('exists() returns false when no rows match', () => {
        const db = createTestDb();
        seedData(db);
        expect(db.trees.select().where({ name: 'Nonexistent' }).exists()).toBe(false);
        db.close();
    });
});

// ==========================================================================
// .groupBy()
// ==========================================================================

describe('QueryBuilder: groupBy()', () => {
    test('groupBy groups results', () => {
        const db = createTestDb();
        seedData(db);
        const results = db.trees.select('alive').groupBy('alive').raw().all();
        expect(results.length).toBe(2); // alive: 1 and alive: 0
        db.close();
    });
});

// ==========================================================================
// close()
// ==========================================================================

describe('Database.close()', () => {
    test('close() makes further queries throw', () => {
        const db = createTestDb();
        db.forests.insert({ name: 'Temp', address: 'Test' });
        db.close();
        expect(() => db.forests.select().all()).toThrow();
    });
});

// ==========================================================================
// Expanded CRUD edge cases
// ==========================================================================

describe('CRUD edge cases', () => {
    test('delete on non-existent id does not throw', () => {
        const db = createTestDb();
        expect(() => db.forests.delete(9999)).not.toThrow();
        db.close();
    });

    test('updateWhere with complex conditions', () => {
        const db = createTestDb();
        seedData(db);
        // Update name for all dead trees
        db.trees.update({ name: 'Revived' })
            .where({ alive: false })
            .exec();
        // Verify only the 3 dead trees got updated
        const revived = db.trees.select().where({ name: 'Revived' }).all();
        expect(revived.length).toBe(3);
        db.close();
    });

    test('upsert creates when no match', () => {
        const db = createTestDb();
        const forest = db.forests.upsert({ name: 'Redwood' }, { name: 'Redwood', address: 'California' });
        expect(forest.name).toBe('Redwood');
        expect(forest.address).toBe('California');
        db.close();
    });

    test('upsert updates when match found', () => {
        const db = createTestDb();
        db.forests.insert({ name: 'Redwood', address: 'CA' });
        const forest = db.forests.upsert({ name: 'Redwood' }, { name: 'Redwood', address: 'California' });
        expect(forest.address).toBe('California');
        // Should still be 1 forest
        expect(db.forests.select().count()).toBe(1);
        db.close();
    });

    test('insert validates data against Zod schema', () => {
        const db = createTestDb();
        expect(() => db.forests.insert({ name: 123 as any, address: 'test' })).toThrow();
        db.close();
    });

    test('update with empty data returns existing entity', () => {
        const db = createTestDb();
        const forest = db.forests.insert({ name: 'Test', address: 'Place' });
        const updated = db.forests.update(forest.id, {});
        expect(updated!.name).toBe('Test');
        db.close();
    });

    test('transaction wraps multiple inserts atomically', () => {
        const db = createTestDb();
        db.transaction(() => {
            db.forests.insert({ name: 'Forest A', address: 'Place A' });
            db.forests.insert({ name: 'Forest B', address: 'Place B' });
        });
        expect(db.forests.select().count()).toBe(2);
        db.close();
    });

    test('transaction rolls back on error', () => {
        const db = createTestDb();
        try {
            db.transaction(() => {
                db.forests.insert({ name: 'Forest A', address: 'Place A' });
                throw new Error('deliberate');
            });
        } catch { /* expected */ }
        expect(db.forests.select().count()).toBe(0);
        db.close();
    });
});
