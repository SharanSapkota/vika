// Runs the log command from vika.yaml (docker logs, kubectl logs, ssh ...)
// and keeps only lines newer than the last run's timestamp bookmark.
import { spawn } from "node:child_process";
import { lineTimestamp } from "./read-line-timestamp.js";

export interface CommandReadResult {
  lines: string[];
  next: { sinceTimestamp?: string }; // newest timestamp seen, for the next run
  timedOut: boolean; // true if we had to stop the command
  exitCode: number | null; // null if it was stopped
}

export function readCommand(command: string, sinceTimestamp: string | undefined, timeoutMs: number): Promise<CommandReadResult> {
  const sinceMs = sinceTimestamp === undefined ? undefined : Date.parse(sinceTimestamp);
  const isNewerThanBookmark = (timestamp: string) => sinceMs === undefined || Date.parse(timestamp) > sinceMs;

  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });

    const lines: string[] = [];
    let newestTimestamp = sinceTimestamp;
    let timedOut = false;

    // Lines without a timestamp (stack traces) follow the decision for the
    // timestamped line before them on the same stream.
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
      stream.setEncoding("utf8"); // handles UTF-8 characters split across chunks
      stream.on("data", (chunk: string) => {
        const parts = (streamState.partial + chunk).split("\n");
        streamState.partial = parts.pop() ?? "";
        for (const part of parts) takeLine(streamState, part);
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
