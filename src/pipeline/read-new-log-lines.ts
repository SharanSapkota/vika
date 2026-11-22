import { isAbsolute, resolve } from "node:path";
import type { LogsSetting } from "../configuration/configuration-schema.js";
import type { Bookmark, Store } from "../database/store-types.js";
import type { FileBookmark } from "../log-parsing/read-log-file.js";
import { readFile } from "../log-parsing/read-log-file.js";
import { readCommand } from "../log-parsing/read-log-command.js";

export const LOG_COMMAND_TIMEOUT_MS = 60_000;

export interface NewLogLines {
  sourceKey: string;
  lines: string[];
  previousBookmark: Bookmark | undefined;
  nextFileBookmark: FileBookmark | undefined;
  notes: string[];
}

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
