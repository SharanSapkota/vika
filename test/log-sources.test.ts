// Tests the two log sources: the incremental file reader and the command reader.
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCommand } from "../src/log-parsing/read-log-command.js";
import { readFile } from "../src/log-parsing/read-log-file.js";

const dir = mkdtempSync(join(tmpdir(), "vika-source-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readFile", () => {
  it("reads only new bytes each time", async () => {
    const path = join(dir, "grow.log");
    writeFileSync(path, "a\nb\n");
    const first = await readFile(path);
    expect(first.lines).toEqual(["a", "b"]);
    expect(first.next.offset).toBe(4);

    appendFileSync(path, "c\n");
    const second = await readFile(path, first.next);
    expect(second.lines).toEqual(["c"]);

    const third = await readFile(path, second.next);
    expect(third.lines).toEqual([]);
    expect(third.next).toEqual(second.next);
  });

  it("leaves a half-written last line for next time", async () => {
    const path = join(dir, "half.log");
    writeFileSync(path, "done\nhalf");
    const first = await readFile(path);
    expect(first.lines).toEqual(["done"]);
    expect(first.next.offset).toBe(5);

    appendFileSync(path, "-finished\n");
    const second = await readFile(path, first.next);
    expect(second.lines).toEqual(["half-finished"]);
  });

  it("starts again from 0 when the file shrinks (rotation by truncation)", async () => {
    const path = join(dir, "shrink.log");
    writeFileSync(path, "old line 1\nold line 2\n");
    const first = await readFile(path);

    writeFileSync(path, "new\n"); // truncated and rewritten, same inode
    const second = await readFile(path, first.next);
    expect(second.lines).toEqual(["new"]);
    expect(second.next.offset).toBe(4);
  });

  it("starts again from 0 when the inode changes (rotation by rename)", async () => {
    const path = join(dir, "rename.log");
    writeFileSync(path, "x\n");
    const first = await readFile(path);

    renameSync(path, `${path}.1`); // the old file is kept, so the new one gets a new inode
    writeFileSync(path, "fresh 1\nfresh 2\n"); // bigger than the old offset
    const second = await readFile(path, first.next);
    expect(second.next.inode).not.toBe(first.next.inode);
    expect(second.lines).toEqual(["fresh 1", "fresh 2"]);
  });
});

describe("readCommand", () => {
  it("collects stdout and stderr together", async () => {
    const result = await readCommand("echo hello; echo oops 1>&2", undefined, 5000);
    expect(result.lines.sort()).toEqual(["hello", "oops"]);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("drops lines at or before sinceTimestamp, with their stack lines", async () => {
    const command =
      "printf '%s\\n' " +
      [
        "'2026-03-01T00:00:00Z ERROR old'",
        "'    at old (/a.ts:1:1)'",
        "'2026-03-02T00:00:00Z ERROR same time as since'",
        "'2026-03-03T00:00:00Z ERROR new'",
        "'    at fresh (/a.ts:2:2)'",
      ].join(" ");
    const result = await readCommand(command, "2026-03-02T00:00:00.000Z", 5000);
    expect(result.lines).toEqual(["2026-03-03T00:00:00Z ERROR new", "    at fresh (/a.ts:2:2)"]);
    expect(result.next.sinceTimestamp).toBe("2026-03-03T00:00:00.000Z");
  });

  it("keeps a last line without a newline when the command ends normally", async () => {
    const result = await readCommand("printf 'one\\ntwo'", undefined, 5000);
    expect(result.lines).toEqual(["one", "two"]);
  });

  it("stops the command after the timeout and returns what it had", async () => {
    const started = Date.now();
    const result = await readCommand("echo first; sleep 10; echo never", undefined, 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.lines).toEqual(["first"]);
  });
});
