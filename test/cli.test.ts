import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "../src/cli";

let dir: string;
let modulePath: string;
let planPath: string;
let messages: string[];
const originalLog = console.log;

beforeEach(() => {
  process.exitCode = 0;
  messages = [];
  console.log = (...values: unknown[]) => {
    messages.push(values.map(String).join(" "));
  };
  dir = mkdtempSync(join(tmpdir(), "orm cli "));
  modulePath = join(dir, "db module.ts");
  planPath = join(dir, "saved plan.json");
  const marker = join(dir, "applied.txt");
  const migrator = {
    findBackups: () => [{
      backup: "users_v1", table: "users",
      version: 1, backupRows: 1, currentRows: 0,
    }],
    createAutoPlan: () => ({
      from: "users_v1", to: "users", conflicts: "abort",
      columns: { name: { literal: "SECRET_VALUE" } },
    }),
    suggestSources: () => [],
    explain: () => "INSERT INTO users VALUES ('SECRET_VALUE')",
    apply: () => {
      writeFileSync(marker, "applied");
      return { fromRows: 1, toRowsBefore: 0, toRowsAfter: 1 };
    },
  };
  // Test module deliberately exports a structural database stub.
  writeFileSync(modulePath, `
    import { writeFileSync } from "node:fs";
    const marker = ${JSON.stringify(marker)};
    export default {
      tables: () => [],
      columns: (name: string) => name === "users_v1"
        ? [{ name: "name", type: "TEXT", notnull: 0,
             dflt_value: null, pk: 0 }]
        : [{ name: "name", type: "TEXT", notnull: 0,
             dflt_value: null, pk: 0 }],
      raw: () => [{ c: 0 }],
      exec: () => {},
      transaction: (fn: () => unknown) => fn(),
      migrator: () => ({
        findBackups: () => [{ backup: "users_v1", table: "users",
          version: 1, backupRows: 1, currentRows: 0 }],
        createAutoPlan: () => ({
          from: "users_v1", to: "users", conflicts: "abort",
          columns: { name: { literal: "SECRET_VALUE" } }
        }),
        suggestSources: () => [],
        explain: () => "INSERT INTO users VALUES ('SECRET_VALUE')",
        apply: () => {
          writeFileSync(marker, "applied");
          return { fromRows: 1, toRowsBefore: 0, toRowsAfter: 1 };
        }
      })
    };
  `);
  writeFileSync(planPath, JSON.stringify({
    from: "users_v1", to: "users", conflicts: "abort",
    columns: { name: { literal: "SECRET_VALUE" } },
  }));
});

afterEach(() => {
  console.log = originalLog;
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

const invoke = (...args: string[]) => runCli(["migrate", ...args]);

test("unknown options and missing values fail with exit code 1", async () => {
  for (const args of [
    ["--bogus"],
    [modulePath, "--bogus"],
    [modulePath, "--from"],
    [modulePath, "--from", "--yes"],
    [modulePath, "--apply", "--dry-run"],
    [modulePath, "--conflicts", "--yes"],
  ]) {
    process.exitCode = 0;
    await expect(invoke(...args)).rejects.toThrow();
    expect(process.exitCode).toBe(1);
  }
});

test("conflicting selections and duplicate options fail", async () => {
  for (const args of [
    [modulePath, "--from", "users_v1"],
    [modulePath, "--apply", planPath, "--save", "out.json"],
    [modulePath, "--table", "users", "--table", "users"],
  ]) {
    await expect(invoke(...args)).rejects.toThrow();
  }
});

test("saved plan cannot apply without confirmation in a pipe", async () => {
  await expect(invoke(modulePath, "--apply", planPath))
    .rejects.toThrow(/noninteractive|--yes/);
  expect(await Bun.file(join(dir, "applied.txt")).exists()).toBe(false);
});

test("dry-run shows the plan and SQL preview but does not apply", async () => {
  await invoke(modulePath, "--apply", planPath, "--dry-run");
  // A local developer tool: the preview of your own migration is shown.
  expect(messages.join("\n")).toContain("INSERT INTO users");
  expect(await Bun.file(join(dir, "applied.txt")).exists()).toBe(false);
});

test("quoted paths with spaces and --yes apply successfully", async () => {
  await invoke(modulePath, "--apply", planPath, "--yes");
  expect(readFileSync(join(dir, "applied.txt"), "utf8")).toBe("applied");
});

// Not tested here: --dry-run with --save on the interactive planning path
// (it prompts on stdin); the code skips the save when dryRun is set.

test("--help, -h and help before a command print the usage", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const logs: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => { logs.push(parts.join(" ")); };
    try {
      process.exitCode = 0;
      await runCli([flag]);
    } finally {
      console.log = log;
    }
    expect(logs.join("\n")).toContain("Usage:");
    expect(process.exitCode).toBe(0);
  }
});
