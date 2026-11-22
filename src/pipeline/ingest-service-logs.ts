import type { LogFormatSetting, LogsSetting } from "../configuration/configuration-schema.js";
import type { Bookmark, Store } from "../database/store-types.js";
import { buildClusters } from "../error-grouping/build-clusters.js";
import { DEFAULT_LANGUAGE, type Language } from "../log-parsing/languages.js";
import { parseLines } from "../log-parsing/parse-log-lines.js";
import type { RedactionKind } from "../redaction/redaction-kinds.js";
import { readNewLogLines } from "./read-new-log-lines.js";
import { findTimestampRange } from "./timestamp-range.js";

export type IngestResult =
  | { status: "ingested"; linesRead: number; entriesKept: number; linesSkipped: number; notes: string[] }
  | { status: "busy"; message: string }
  | { status: "not-supported"; message: string };

export interface IngestInput {
  store: Store;
  serviceName: string;
  logs: LogsSetting;
  configurationDirectory: string;
  redactionKinds: readonly RedactionKind[];
  language?: Language; // default "javascript"
  logFormat?: LogFormatSetting; // default "auto"
}

const GLOB_CHARACTERS = /[*?[\]{}]/;

export async function ingestServiceLogs(input: IngestInput): Promise<IngestResult> {
  const { store, serviceName, logs } = input;
  if (typeof logs === "string" && GLOB_CHARACTERS.test(logs)) {
    return { status: "not-supported", message: `services.${serviceName}.logs is a glob pattern; globs are not supported yet, so no logs were read` };
  }

  const lockResult = await store.withRunLock(serviceName, async () => {
    const newLines = await readNewLogLines(store, serviceName, logs, input.configurationDirectory);

    const bookmark: Bookmark = { sourceKey: newLines.sourceKey };
    if (newLines.nextFileBookmark !== undefined) bookmark.file = newLines.nextFileBookmark;
    const previousLastTimestamp = newLines.previousBookmark?.lastTimestamp;
    if (previousLastTimestamp !== undefined) bookmark.lastTimestamp = previousLastTimestamp;
    const timestampRange = findTimestampRange(newLines.lines);
    if (timestampRange !== undefined) {
      if (previousLastTimestamp === undefined || timestampRange.newest > previousLastTimestamp) bookmark.lastTimestamp = timestampRange.newest;
      bookmark.firstReadAt = timestampRange.earliest;
    }

    const format = input.logFormat === undefined || input.logFormat === "auto" ? undefined : input.logFormat;
    const { entries, skipped } = parseLines(newLines.lines, format, input.redactionKinds, input.language ?? DEFAULT_LANGUAGE);
    const clustering = buildClusters(entries, serviceName, await store.getMinerState(serviceName), input.redactionKinds);
    await store.saveBatch({ service: serviceName, clusters: clustering.clusters, minerState: clustering.state, bookmark });

    return { status: "ingested" as const, linesRead: newLines.lines.length, entriesKept: entries.length, linesSkipped: skipped, notes: newLines.notes };
  });

  if (lockResult === "busy") {
    return { status: "busy", message: `skipped: another vika run is working on service "${serviceName}" right now; try again when it finishes` };
  }
  return lockResult;
}
