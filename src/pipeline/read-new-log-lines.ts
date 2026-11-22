// Reads the lines a service's log source has added since the last run:
// a file from its byte-offset bookmark, or a command's output newer than
// its timestamp bookmark. Errors name the setting and the file, in plain English.
import { isAbsolute, resolve } from "node:path";
import type { LogsSetting } from "../configuration/configuration-schema.js";
import type { Bookmark, Store } from "../database/store-types.js";
import type { FileBookmark } from "../log-parsing/read-log-file.js";
import { readFile } from "../log-parsing/read-log-file.js";
import { readCommand } from "../log-parsing/read-log-command.js";

// A log command that runs longer than this is stopped; what it printed so far is used.
export const LOG_COMMAND_TIMEOUT_MS = 60_000;

export interface NewLogLines {
  sourceKey: string; // which bookmark these lines belong to
  lines: string[];
  previousBookmark: Bookmark | undefined;
  nextFileBookmark: FileBookmark | undefined; // files only
  notes: string[]; // e.g. "the log command exited with code 1"
}

// Key under which the bookmark is saved. Changing the path or the command
// starts a new bookmark (and reads that source from the start).
export function makeSourceKey(logs: LogsSetting, configurationDirectory: string): string {
  if (typeof logs !== "string") return `command:${logs.command}`;
  return `file:${isAbsolute(logs) ? logs : resolve(configurationDirectory, logs)}`;
}

export async function readNewLogLines(store: Store, serviceName: string, logs: LogsSetting, configurationDirectory: string): Promise<NewLogLines> {
  const sourceKey = makeSourceKey(logs, configurationDirectory);
  const previousBookmark = await store.getBookmark(serviceName, sourceKey);

  if (typeof logs === "string") {
    const filePath = sourceKey.slice("file:".length);
    try {
      const fileRead = await readFile(filePath, previousBookmark?.file);
      return { sourceKey, lines: fileRead.lines, previousBookmark, nextFileBookmark: fileRead.next, notes: [] };
    } catch (error) {
      throw new Error(`services.${serviceName}.logs: cannot read ${filePath} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, {
        cause: error,
      });
    }
  }

  const commandRead = await readCommand(logs.command, previousBookmark?.lastTimestamp, LOG_COMMAND_TIMEOUT_MS);
  const notes: string[] = [];
  if (commandRead.timedOut) notes.push(`the log command was stopped after ${LOG_COMMAND_TIMEOUT_MS / 1000} seconds; used what it printed until then`);
  else if (commandRead.exitCode !== 0) notes.push(`the log command exited with code ${commandRead.exitCode}; used what it printed`);
  return { sourceKey, lines: commandRead.lines, previousBookmark, nextFileBookmark: undefined, notes };
}
