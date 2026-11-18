/**
 * entity.ts — Entity augmentation logic extracted from Database class.
 *
 * Handles attaching .update(), .delete(), relationship navigation methods,
 * and the auto-persist proxy to raw row objects.
 */
import type { AugmentedEntity, Relationship } from "./types";
import { getStorableFields, transformForStorage } from "./schema";
import type { DatabaseContext } from "./context";
import { getById, findMany, update, deleteEntity } from "./crud";

// Per-database navigation descriptors and per-schema writable keys do not
// change as rows are hydrated. Avoid scanning every relationship and rebuilding
// a Set on each read; the proxy itself remains mandatory for auto-persist.
const navigationCache = new WeakMap<DatabaseContext, Map<string, Relationship[]>>();
const writableCache = new WeakMap<object, Set<string>>();
const proxyHandlers = new WeakMap<DatabaseContext, Map<string, ProxyHandler<any>>>();

function navigationFor(ctx: DatabaseContext, table: string): Relationship[] {
  let byTable = navigationCache.get(ctx);
  if (!byTable) {
    byTable = new Map();
    for (const relation of ctx.relationships) {
      let list = byTable.get(relation.from);
      if (!list) byTable.set(relation.from, list = []);
      list.push(relation);
    }
    navigationCache.set(ctx, byTable);
  }
  return byTable.get(table) ?? [];
}

function writableFor(ctx: DatabaseContext, table: string): Set<string> {
  const schema = ctx.schemas[table]!;
  let keys = writableCache.get(schema);
  if (!keys) {
    keys = new Set(getStorableFields(schema).map(field => field.name));
    writableCache.set(schema, keys);
  }
  return keys;
}

/**
 * Augment a raw entity with:
 * - .update(data) → persist partial update
 * - .delete() → delete from DB
 * - Lazy relationship accessors (author(), books(), etc.)
 * - Auto-persist proxy: `entity.name = 'New'` auto-updates DB
 */
export function attachMethods<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  entity: T,
): AugmentedEntity<any> {
  const augmented = entity as any;
  const isView = ctx.viewNames.has(entityName);
  if (!isView) {
    augmented.update = (data: any) => update(ctx, entityName, entity.id, data);
    augmented.delete = () => deleteEntity(ctx, entityName, entity.id);
  }

  // Attach lazy relationship navigation
  for (const rel of navigationFor(ctx, entityName)) {
    if (rel.from === entityName && rel.type === "belongs-to") {
      // book.author() → lazy load parent via author_id FK
      augmented[rel.relationshipField] = () => {
        const fkValue = entity[rel.foreignKey];
        return fkValue == null ? null : getById(ctx, rel.to, fkValue);
      };
    } else if (rel.from === entityName && rel.type === "one-to-many") {
      // author.books() → lazy load children
      augmented[rel.relationshipField] = () =>
        findMany(ctx, rel.to, { [rel.foreignKey]: entity.id });
    }
  }

  // Attach computed/virtual getters from context
  const computedGetters = ctx.computed[entityName];
  if (computedGetters) {
    for (const [key, fn] of Object.entries(computedGetters)) {
      Object.defineProperty(augmented, key, {
        get: () => fn(augmented),
        enumerable: true,
        configurable: true,
      });
    }
  }

  // Auto-persist proxy: setting a field auto-updates the DB row
  if (isView) return augmented;

  let byTable = proxyHandlers.get(ctx);
  if (!byTable) {
    byTable = new Map();
    proxyHandlers.set(ctx, byTable);
  }
  let handler = byTable.get(entityName);
  if (!handler) {
    const storableFieldNames = writableFor(ctx, entityName);
    handler = {
      set(target, prop, value) {
        if (typeof prop === "string" && storableFieldNames.has(prop) && target[prop] !== value) {
          const saved = update(ctx, entityName, target.id, { [prop]: value });
          // A vetoed/tombstoned write must not change the in-memory entity.
          // Keep the stored value after hook transformations and coercions.
          if (!saved) return true;
          for (const field of storableFieldNames) {
            if (Object.hasOwn(saved, field)) target[field] = saved[field];
          }
          if (ctx.timestamps) target.updatedAt = saved.updatedAt;
          return true;
        }
        target[prop] = value;
        return true;
      },
    };
    byTable.set(entityName, handler);
  }
  return new Proxy(augmented, handler);
}
