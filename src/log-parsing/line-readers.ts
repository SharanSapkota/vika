import type { RedactionKind } from "../redaction/redaction-kinds.js";
import { parseJson, readJsonStart } from "./json-log-format.js";
import type { Language } from "./languages.js";
import type { LineStart, LogFormat, ParseResult } from "./log-entry-types.js";
import { parseNginx, readNginxLine } from "./nginx-log-format.js";
import { parseText, readTextStart } from "./text-log-format.js";

export const LINE_START_READERS: Record<LogFormat, (line: string) => LineStart> = {
  text: readTextStart,
  json: readJsonStart,
  nginx: readNginxLine,
};

export type FormatParser = (lines: string[], redactionKinds?: readonly RedactionKind[], language?: Language) => ParseResult;

export const FORMAT_PARSERS: Record<LogFormat, FormatParser> = {
  text: parseText,
  json: parseJson,
  nginx: parseNginx,
};
