// A tiny .env reader. Supports:
//   KEY=value
//   KEY="value with spaces and \n escapes"   KEY='literal value'
//   KEY=value # a comment after a space      # a whole-line comment
//   blank lines
// Values already set in the real environment always win: a .env file is a
// convenience for local runs, never a way to override what the operator set.
// Error messages give the line number but never the line, which may hold a secret.
import { existsSync, readFileSync } from "node:fs";
import { ConfigurationError } from "./configuration-errors.js";

const ENVIRONMENT_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function readDoubleQuoted(innerText: string): string {
  return innerText.replace(/\\([nrt"\\])/g, (_escape, character: string) =>
    character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : character,
  );
}

// The index of the quote that closes a double-quoted value; \" doesn't close it.
function findClosingDoubleQuote(value: string): number {
  for (let characterIndex = 1; characterIndex < value.length; characterIndex++) {
    if (value[characterIndex] === "\\") characterIndex++; // skip the escaped character
    else if (value[characterIndex] === '"') return characterIndex;
  }
  return -1;
}

// The value part of a line, or undefined if it is broken (unclosed quote,
// or something other than a comment after the closing quote).
function readValue(rawValue: string): string | undefined {
  const value = rawValue.trim();
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    // Unquoted: " #" starts a comment, so "a#b" keeps its "#".
    return value.replace(/\s+#.*$/, "");
  }
  const closingIndex = quote === '"' ? findClosingDoubleQuote(value) : value.indexOf("'", 1);
  if (closingIndex === -1) return undefined;
  const afterClosingQuote = value.slice(closingIndex + 1).trim();
  if (afterClosingQuote !== "" && !afterClosingQuote.startsWith("#")) return undefined;
  const innerText = value.slice(1, closingIndex);
  return quote === '"' ? readDoubleQuoted(innerText) : innerText;
}

// Variable name -> value, from the text of a .env file.
export function parseEnvironmentFile(fileText: string, fileLabel: string): Record<string, string> {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const [lineIndex, rawLine] of fileText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const lineMatch = ENVIRONMENT_LINE.exec(line);
    const value = lineMatch ? readValue(lineMatch[2]!) : undefined;
    if (!lineMatch || value === undefined) {
      problems.push(`${fileLabel} line ${lineIndex + 1} is not KEY=value (or has an unclosed quote)`);
      continue;
    }
    values[lineMatch[1]!] = value;
  }
  if (problems.length > 0) throw new ConfigurationError(`Problems in ${fileLabel}:`, problems);
  return values;
}

// The .env file's values, or nothing if there is no file.
export function readEnvironmentFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseEnvironmentFile(readFileSync(filePath, "utf8"), filePath);
}

// The real environment plus the file's values for variables it doesn't set.
export function mergeEnvironment(
  realEnvironment: Record<string, string | undefined>,
  fileValues: Record<string, string>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...fileValues };
  for (const [name, value] of Object.entries(realEnvironment)) if (value !== undefined) merged[name] = value;
  return merged;
}
