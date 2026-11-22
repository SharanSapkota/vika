import { spawn } from "node:child_process";
import { lineTimestamp } from "./read-line-timestamp.js";

export interface CommandReadResult {
  lines: string[];
  next: { sinceTimestamp?: string };
  timedOut: boolean;
  exitCode: number | null;
}

export function readCommand(command: string, sinceTimestamp: string | undefined, timeoutMs: number): Promise<CommandReadResult> {
  const sinceMs = sinceTimestamp === undefined ? undefined : Date.parse(sinceTimestamp);
  const isNewerThanBookmark = (timestamp: string) => sinceMs === undefined || Date.parse(timestamp) > sinceMs;

  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });

    const lines: string[] = [];
    let newestTimestamp = sinceTimestamp;
    let timedOut = false;

    const streams = {
      stdout: { partial: "", keep: sinceMs === undefined },
      stderr: { partial: "", keep: sinceMs === undefined },
    };

    const takeLine = (streamState: { keep: boolean }, rawLine: string) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const timestamp = lineTimestamp(line);
      if (timestamp !== undefined) {
        streamState.keep = isNewerThanBookmark(timestamp);
        if (streamState.keep && (newestTimestamp === undefined || Date.parse(timestamp) > Date.parse(newestTimestamp))) {
          newestTimestamp = timestamp;
        }
      }
      if (streamState.keep) lines.push(line);
    };

    for (const streamName of ["stdout", "stderr"] as const) {
      const streamState = streams[streamName];
      const stream = child[streamName];
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const parts = (streamState.partial + chunk).split("\n");
        streamState.partial = parts.pop() ?? "";
        for (const part of parts) takeLine(streamState, part);
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (!timedOut) {
        for (const streamState of Object.values(streams)) {
          if (streamState.partial !== "") takeLine(streamState, streamState.partial);
        }
      }
      const next = newestTimestamp === undefined ? {} : { sinceTimestamp: newestTimestamp };
      resolve({ lines, next, timedOut, exitCode: timedOut ? null : exitCode });
    });
  });
}
