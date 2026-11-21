
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { lineTimestamp } from "./index.js";

export interface FileBookmark {
  offset: number; // bytes already consumed
  inode: number; // which file that offset belongs to
}

export interface FileRead {
  lines: string[];
  next: FileBookmark;
}

export async function readFile(path: string, bookmark?: FileBookmark): Promise<FileRead> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const sameFile = bookmark !== undefined && bookmark.inode === info.ino && bookmark.offset <= info.size;
    const start = sameFile ? bookmark.offset : 0;
    const length = info.size - start;
    if (length <= 0) return { lines: [], next: { offset: start, inode: info.ino } };

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const data = buffer.subarray(0, bytesRead);

    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], next: { offset: start, inode: info.ino } };

    const lines = data
      .subarray(0, lastNewline)
      .toString("utf8")
      .split("\n")
      .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    return { lines, next: { offset: start + lastNewline + 1, inode: info.ino } };
  } finally {
    await handle.close();
  }
}

export interface CommandRead {
  lines: string[];
  next: { sinceTimestamp?: string }; // newest timestamp seen, for the next run
  timedOut: boolean; // true if we had to stop the command
  exitCode: number | null; // null if it was stopped
}

export function readCommand(command: string, sinceTimestamp: string | undefined, timeoutMs: number): Promise<CommandRead> {
  const sinceMs = sinceTimestamp === undefined ? undefined : Date.parse(sinceTimestamp);
  const isNew = (ts: string) => sinceMs === undefined || Date.parse(ts) > sinceMs;

  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });

    const lines: string[] = [];
    let newest = sinceTimestamp;
    let timedOut = false;

    const streams = {
      stdout: { partial: "", keep: sinceMs === undefined },
      stderr: { partial: "", keep: sinceMs === undefined },
    };

    const takeLine = (state: { keep: boolean }, raw: string) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const ts = lineTimestamp(line);
      if (ts !== undefined) {
        state.keep = isNew(ts);
        if (state.keep && (newest === undefined || Date.parse(ts) > Date.parse(newest))) newest = ts;
      }
      if (state.keep) lines.push(line);
    };

    for (const name of ["stdout", "stderr"] as const) {
      const state = streams[name];
      const stream = child[name];
      stream.setEncoding("utf8"); // handles UTF-8 characters split across chunks
      stream.on("data", (chunk: string) => {
        const parts = (state.partial + chunk).split("\n");
        state.partial = parts.pop() ?? "";
        for (const part of parts) takeLine(state, part);
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL"); // the whole process group
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!timedOut) {
        for (const state of Object.values(streams)) {
          if (state.partial !== "") takeLine(state, state.partial);
        }
      }
      const next = newest === undefined ? {} : { sinceTimestamp: newest };
      resolve({ lines, next, timedOut, exitCode: timedOut ? null : code });
    });
  });
}
