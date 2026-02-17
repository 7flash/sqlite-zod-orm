/**
 * relationships.ts — z.lazy() Relationships
 *
 * Demonstrates:
 *  - Defining parent/child with z.lazy()
 *  - Auto FK column creation
 *  - Inserting via .push()
 *  - Navigating belongs-to (child → parent)
 *  - Navigating one-to-many (parent → children)
 *
 * Run: bun examples/relationships.ts
 */
import { Database, z } from '../src/index';

// --- Schemas with z.lazy() relationships ---

interface Forest { name: string; region: string; trees?: Tree[]; }
interface Tree { species: string; height: number; alive: boolean; forest?: Forest; }

const ForestSchema: z.ZodType<Forest> = z.object({
    name: z.string(),
    region: z.string(),
    trees: z.lazy(() => z.array(TreeSchema)).optional(),
});

const TreeSchema: z.ZodType<Tree> = z.object({
    species: z.string(),
    height: z.number().default(1),
    alive: z.boolean().default(true),
    forest: z.lazy(() => ForestSchema).optional(),
});

// --- Database ---

const db = new Database(':memory:', {
    forests: ForestSchema,
    trees: TreeSchema,
});

// --- Insert parent ---

const sherwood = db.forests.insert({ name: 'Sherwood', region: 'East Midlands' });
const amazon = db.forests.insert({ name: 'Amazon', region: 'South America' });

console.log('Created forests:', sherwood.name, amazon.name);

// --- Insert via relationship ---

// .push() sets forestId automatically
sherwood.trees.push({ species: 'Major Oak', height: 28 });
sherwood.trees.push({ species: 'English Elm', height: 18, alive: false });
amazon.trees.push({ species: 'Brazil Nut', height: 50 });
amazon.trees.push({ species: 'Rubber Tree', height: 30 });

console.log('Sherwood trees:', sherwood.trees.find().length);
console.log('Amazon trees:', amazon.trees.find().length);

// --- Navigate belongs-to (child → parent) ---

const oak = db.trees.get({ species: 'Major Oak' })!;
const forest = oak.forest(); // lazy load parent
console.log(`${oak.species} is in ${forest.name}`);

// --- Navigate one-to-many (parent → children) ---

const sherwoodTrees = sherwood.trees.find();
console.log('Sherwood trees:', sherwoodTrees.map((t: any) => `${t.species} (${t.height}m)`));

// Finding with filters through relationship
const aliveTrees = sherwood.trees.find({ alive: true });
console.log('Alive in Sherwood:', aliveTrees.map((t: any) => t.species));

// --- Update via relationship ---

sherwood.trees.update(oak.id, { height: 30 });
const updatedOak = db.trees.get(oak.id)!;
console.log(`${updatedOak.species} grew to ${updatedOak.height}m`);

// --- Insert or update (upsert) ---

sherwood.trees.upsert({ species: 'Major Oak' }, { species: 'Major Oak', height: 32 });
console.log('After upsert:', db.trees.get({ species: 'Major Oak' })?.height);

// --- Delete through relationship ---

sherwood.trees.delete(oak.id);
console.log('After delete, Sherwood trees:', sherwood.trees.find().length);

console.log('\n✅ relationships.ts complete');
