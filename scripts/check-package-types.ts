import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Test the published boundary, including a separate application measure-fn 5.x.
// Keep the fixture on failure so the compiler's diagnostics can be reproduced.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), "sqlite-zod-orm-types-"));
function run(command: string[], cwd = fixture): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.toString();
}
const packed = JSON.parse(run(["npm", "pack", "--json", "--pack-destination", fixture], root));
const archive = join(fixture, packed[0].filename);
writeFileSync(join(fixture, "package.json"), JSON.stringify({
  private: true,
  type: "module",
  dependencies: {
    "sqlite-zod-orm": `file:${archive.replaceAll("\\", "/")}`,
    "measure-fn": "5.3.1",
    "bun-types": "1.4.3",
  },
}));
run([process.execPath, "install"]);
writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ESNext", lib: ["ESNext"], module: "ESNext", moduleResolution: "bundler",
    strict: true, strictFunctionTypes: true, skipLibCheck: false,
    noEmit: true, types: ["bun-types"], typeRoots: ["./node_modules", "./node_modules/@types"],
  },
  include: ["consumer.ts"],
}));
writeFileSync(join(fixture, "consumer.ts"), `
import { Database, z } from "sqlite-zod-orm";
import { createMeasure } from "measure-fn";
const db = new Database(":memory:", {
  agents: z.object({ name: z.string() }),
  grants: z.object({ agentRef: z.number(), amount: z.number() }),
}, { relations: { grants: { agentRef: "agents" } }, debug: true, reactive: false });
const agent = db.agents.insert({ name: "strict" });
const grant = db.grants.insert({ agentRef: agent.id, amount: 1 });
const fk: number = grant.agentRef;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type AgentRefIsNumber = Expect<Equal<typeof grant.agentRef, number>>;
const scalarTypeProof: AgentRefIsNumber = true;
const related = grant.agentRefRelation();
const relationFk: number = agent.grants()[0]!.agentRef;
const selected: number = db.grants.select().get()!.agentRef;
const projected: number = db.grants.select("agentRef", "amount").raw().get()!.agentRef;
const fetched: number = db.grants.get(grant.id)!.agentRef;
const updated: number = db.grants.update(grant.id, { amount: 2 })!.agentRef;
if (scalarTypeProof !== true || fk !== agent.id || related?.id !== fk || selected !== fk || projected !== fk || fetched !== fk || updated !== fk || relationFk !== fk) {
  throw new Error("FK scalar changed during debug instrumentation");
}
let rejectedInvalidWrite = false;
try { db.grants.insert({ agentRef: agent.id, amount: "invalid" } as never); }
catch { rejectedInvalidWrite = true; }
if (!rejectedInvalidWrite) throw new Error("Debug instrumentation swallowed a validation error");
if (typeof createMeasure("app").sync !== "function") throw new Error("Application measure-fn missing");
db.close();
`);
// TypeScript 7 exports package.json but not the private bin/tsc subpath.
const compiler = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin", "tsc");
run([process.execPath, compiler, "-p", join(fixture, "tsconfig.json"), "--pretty", "false"]);
// Also node16 resolution: declarations must use explicit .js specifiers.
const strictConfig = JSON.parse(readFileSync(join(fixture, "tsconfig.json"), "utf8"));
strictConfig.compilerOptions.module = "Node16";
strictConfig.compilerOptions.moduleResolution = "Node16";
writeFileSync(join(fixture, "tsconfig.node16.json"), JSON.stringify(strictConfig));
run([process.execPath, compiler, "-p", join(fixture, "tsconfig.node16.json"), "--pretty", "false"]);
run([process.execPath, "consumer.ts"]);
const declarations = readFileSync(join(fixture, "node_modules/sqlite-zod-orm/dist/database.d.ts"), "utf8");
if (declarations.includes('from "measure-fn"')) throw new Error("Instrumentation leaked into public declarations");
console.log(`Packed strict consumer and measure-fn 5.x debug runtime passed (${fixture})`);
