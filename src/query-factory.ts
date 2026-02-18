/**
 * query-factory.ts — QueryBuilder factory extracted from Database class.
 *
 * Creates fully-wired QueryBuilder instances with executor, join resolver,
 * condition resolver, revision getter, and eager loader closures.
 */
import { QueryBuilder } from './query-builder';
import { transformFromStorage } from './schema';
import type { DatabaseContext } from './db-context';

/**
 * Create a QueryBuilder instance wired to the database.
 *
 * Constructs all the closures (executor, joinResolver, conditionResolver,
 * revisionGetter, eagerLoader) that the QueryBuilder needs to execute
 * queries against the actual SQLite database.
 */
export function createQueryBuilder(ctx: DatabaseContext, entityName: string, initialCols: string[]): QueryBuilder<any> {
    const schema = ctx.schemas[entityName]!;

    const executor = (sql: string, params: any[], raw: boolean): any[] => {
        const rows = ctx.db.query(sql).all(...params);
        if (raw) return rows;
        return rows.map((row: any) => ctx.attachMethods(entityName, transformFromStorage(row, schema)));
    };

    const singleExecutor = (sql: string, params: any[], raw: boolean): any | null => {
        const results = executor(sql, params, raw);
        return results.length > 0 ? results[0] : null;
    };

    const joinResolver = (fromTable: string, toTable: string): { fk: string; pk: string } | null => {
        const belongsTo = ctx.relationships.find(
            r => r.type === 'belongs-to' && r.from === fromTable && r.to === toTable
        );
        if (belongsTo) return { fk: belongsTo.foreignKey, pk: 'id' };
        const reverse = ctx.relationships.find(
            r => r.type === 'belongs-to' && r.from === toTable && r.to === fromTable
        );
        if (reverse) return { fk: 'id', pk: reverse.foreignKey };
        return null;
    };

    // Revision getter — allows .subscribe() / .each() to detect ALL changes
    const revisionGetter = () => ctx.getRevision(entityName);

    // Condition resolver: { author: aliceEntity } → { author_id: 1 }
    const conditionResolver = (conditions: Record<string, any>): Record<string, any> => {
        const resolved: Record<string, any> = {};
        for (const [key, value] of Object.entries(conditions)) {
            // Detect entity references: objects with `id` and `delete` (augmented entities)
            if (value && typeof value === 'object' && typeof value.id === 'number' && typeof value.delete === 'function') {
                // Find a belongs-to relationship: entityName has a FK named `key_id` pointing to another table
                const fkCol = key + '_id';
                const rel = ctx.relationships.find(
                    r => r.type === 'belongs-to' && r.from === entityName && r.foreignKey === fkCol
                );
                if (rel) {
                    resolved[fkCol] = value.id;
                } else {
                    // Fallback: try any relationship that matches the key as the nav name
                    const relByNav = ctx.relationships.find(
                        r => r.type === 'belongs-to' && r.from === entityName && r.to === key + 's'
                    ) || ctx.relationships.find(
                        r => r.type === 'belongs-to' && r.from === entityName && r.to === key
                    );
                    if (relByNav) {
                        resolved[relByNav.foreignKey] = value.id;
                    } else {
                        resolved[key] = value; // pass through
                    }
                }
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    };

    // Eager loader: resolves .with('books') → batch load children
    const eagerLoader = (parentTable: string, relation: string, parentIds: number[]): { key: string; groups: Map<number, any[]> } | null => {
        // 1. Try one-to-many: parentTable has-many relation (e.g., authors → books)
        const hasMany = ctx.relationships.find(
            r => r.type === 'one-to-many' && r.from === parentTable && r.relationshipField === relation
        );
        if (hasMany) {
            // Find the belongs-to FK on the child table
            const belongsTo = ctx.relationships.find(
                r => r.type === 'belongs-to' && r.from === hasMany.to && r.to === parentTable
            );
            if (belongsTo) {
                const fk = belongsTo.foreignKey;
                const placeholders = parentIds.map(() => '?').join(', ');
                const childRows = ctx.db.query(
                    `SELECT * FROM ${hasMany.to} WHERE ${fk} IN (${placeholders})`
                ).all(...parentIds) as any[];

                const groups = new Map<number, any[]>();
                const childSchema = ctx.schemas[hasMany.to]!;
                for (const rawRow of childRows) {
                    const entity = ctx.attachMethods(
                        hasMany.to,
                        transformFromStorage(rawRow, childSchema)
                    );
                    const parentId = rawRow[fk] as number;
                    if (!groups.has(parentId)) groups.set(parentId, []);
                    groups.get(parentId)!.push(entity);
                }
                return { key: relation, groups };
            }
        }

        // 2. Try belongs-to: parentTable belongs-to relation (e.g., books → author)
        const belongsTo = ctx.relationships.find(
            r => r.type === 'belongs-to' && r.from === parentTable && r.relationshipField === relation
        );
        if (belongsTo) {
            // belongs-to eager loading is trickier — skip for now, handled by lazy nav
            return null;
        }

        return null;
    };

    const builder = new QueryBuilder(entityName, executor, singleExecutor, joinResolver, conditionResolver, revisionGetter, eagerLoader, ctx.pollInterval);
    if (initialCols.length > 0) builder.select(...initialCols);
    return builder;
}
