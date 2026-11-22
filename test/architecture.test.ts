// Checks project rules that are easy to break by accident.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

// Every .ts file under src/.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

// import ... from "pg", import "pg", import("pg"), require("pg"), and "pg/..." subpaths.
const IMPORTS_PG = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']pg(?:\/[^"']*)?["']/;

describe("architecture", () => {
  it('only src/database/database-store.ts imports "pg"', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    const importers = files.filter((file) => IMPORTS_PG.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file));
    expect(importers).toEqual([join("database", "database-store.ts")]);
  });
});
