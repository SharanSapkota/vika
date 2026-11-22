// PURE. Turns one regression and its top suspects into the exact message
// text that `vika report --explain` would send to the AI.
//
// What goes in: the exception type, the redacted headline, the top stack
// frames (file, line, function), and for each of the top 3 suspects its
// commit, PR number, evidence, reason and a diff limited to the files that
// matter. What never goes in: raw log lines, author names and emails, tokens,
// IP addresses, or any secret vika knows about.
import { hideSecrets } from "../configuration/hide-secrets.js";
import { redact } from "../redaction/redact-sensitive-text.js";
import type { RedactionKind } from "../redaction/redaction-kinds.js";
import type { Suspect } from "../suspect-attribution/suspect-types.js";
import type { ExplanationRequest, ExplanationRequestInput, SuspectDiff } from "./explanation-types.js";
import { findPossibleSecret } from "./find-possible-secret.js";

export const MAX_SUSPECTS_SENT = 3;

// About 6000 tokens. A token is roughly 4 characters of English or code, so
// the whole message is kept under this many characters.
export const MAX_REQUEST_TOKENS = 6000;
export const CHARACTERS_PER_TOKEN = 4;
export const MAX_REQUEST_CHARACTERS = MAX_REQUEST_TOKENS * CHARACTERS_PER_TOKEN;

// Emails, tokens and IPs are never sent, even if vika.yaml's `redact` list
// leaves one of them out: that list decides what is stored, not what leaves.
const ALWAYS_REDACTED_KINDS: readonly RedactionKind[] = ["email", "jwt", "ip"];

function makeTextSafe(text: string, input: Pick<ExplanationRequestInput, "redactionKinds" | "secrets">): string {
  const kinds = [...new Set([...input.redactionKinds, ...ALWAYS_REDACTED_KINDS])];
  return redact(hideSecrets(text, input.secrets), kinds);
}

function describeCutLines(lineCount: number): string {
  return `[diff cut: ${lineCount} more ${lineCount === 1 ? "line" : "lines"}]`;
}

const DIFF_INDENT = "    ";

// Room kept for the "[diff cut: ...]" notes and line breaks between parts.
const SPARE_CHARACTERS = 200;

// Keeps whole lines from the top until the line or character limit is hit,
// and says how many lines were cut.
function cutDiff(diffLines: string[], maxLines: number, maxCharacters: number): string[] {
  const keptLines: string[] = [];
  let usedCharacters = 0;
  for (const line of diffLines) {
    if (keptLines.length >= maxLines || usedCharacters + line.length + 1 > maxCharacters) break;
    keptLines.push(line);
    usedCharacters += line.length + 1;
  }
  const cutLineCount = diffLines.length - keptLines.length;
  return cutLineCount === 0 ? keptLines : [...keptLines, `${DIFF_INDENT}${describeCutLines(cutLineCount)}`];
}

function describeSuspectHeader(suspect: Suspect, suspectNumber: number): string[] {
  const location = suspect.lineNumber === null ? suspect.filePath : `${suspect.filePath}:${suspect.lineNumber}`;
  return [
    `Suspect ${suspectNumber}: commit ${suspect.commitSha}${suspect.prNumber === null ? "" : ` (PR #${suspect.prNumber})`}`,
    `  Evidence: ${suspect.evidenceKind}, confidence ${suspect.confidence}`,
    `  Location: ${location || "(no file)"}`,
    ...(suspect.lineText === null ? [] : [`  Line: ${suspect.lineText.trim()}`]),
    `  Reason: ${suspect.reason}`,
  ];
}

// The diff text that may be sent for one suspect, or why it is left out.
function chooseDiffText(suspectDiff: SuspectDiff | undefined): { diffText: string | null; leftOutReason: string | null } {
  if (suspectDiff === undefined) return { diffText: null, leftOutReason: "not read" };
  if (suspectDiff.diffText === null) return { diffText: null, leftOutReason: suspectDiff.problem ?? "not read" };
  if (suspectDiff.diffText.trim() === "") return { diffText: null, leftOutReason: "no changes in these files" };
  // Checked on the raw text, before anything is masked.
  const possibleSecret = findPossibleSecret(suspectDiff.diffText);
  if (possibleSecret !== null) return { diffText: null, leftOutReason: `possible secret (${possibleSecret})` };
  return { diffText: suspectDiff.diffText, leftOutReason: null };
}

export function buildExplanationRequest(input: ExplanationRequestInput): ExplanationRequest {
  const safe = (text: string) => makeTextSafe(text, input);
  const suspects = input.suspects.slice(0, MAX_SUSPECTS_SENT);
  const leftOutNotes: string[] = [];

  const errorLines = [
    "An error group started after a deploy. vika ranked the suspect commits below with fixed rules.",
    "Give your opinion on which one, if any, most likely caused it.",
    "",
    "Error",
    `  Type: ${input.regression.exceptionType ?? "(not known)"}`,
    `  Message: ${input.regression.message}`,
    "  Stack trace, innermost first:",
    ...(input.regression.topFrames.length === 0
      ? ["    (no stack trace)"]
      : input.regression.topFrames.map(
          (frame, frameIndex) => `    ${frameIndex + 1}. ${frame.functionName ?? "(anonymous)"} at ${frame.filePath}:${frame.lineNumber}`,
        )),
  ];

  // Each suspect: its header, then (if allowed) its diff. Diffs are cut to
  // maxDiffLines first; the character budget is applied below.
  const suspectSections = suspects.map((suspect, suspectIndex) => {
    const headerLines = describeSuspectHeader(suspect, suspectIndex + 1).map(safe);
    const { diffText, leftOutReason } = chooseDiffText(input.suspectDiffs.find((suspectDiff) => suspectDiff.commitSha === suspect.commitSha));
    if (leftOutReason !== null) {
      const note = `diff left out: ${leftOutReason}`;
      leftOutNotes.push(`Suspect ${suspectIndex + 1} (commit ${suspect.commitSha.slice(0, 7)}): ${note}`);
      return { headerLines: [...headerLines, `  [${note}]`], diffLines: [] as string[] };
    }
    const diffLines = safe(diffText!).replace(/\n+$/, "").split("\n").map((line) => `${DIFF_INDENT}${line}`);
    return { headerLines: [...headerLines, "  Diff:"], diffLines };
  });

  const introductionLines = [
    ...errorLines.map(safe),
    "",
    suspects.length === 0 ? "Suspects: none" : `Suspects (${suspects.length}, in vika's order)`,
  ];
  const fixedCharacters = [...introductionLines, ...suspectSections.flatMap((section) => ["", ...section.headerLines])].join("\n").length;

  // Share the characters left over between the diffs, in ranking order; a
  // short diff leaves its unused share to the ones after it.
  let remainingCharacters = Math.max(0, MAX_REQUEST_CHARACTERS - fixedCharacters - SPARE_CHARACTERS);
  let diffsLeft = suspectSections.filter((section) => section.diffLines.length > 0).length;
  const sectionLines = suspectSections.flatMap((section) => {
    if (section.diffLines.length === 0) return ["", ...section.headerLines];
    const keptLines = cutDiff(section.diffLines, input.maxDiffLines, Math.floor(remainingCharacters / diffsLeft));
    remainingCharacters -= keptLines.join("\n").length + 1;
    diffsLeft -= 1;
    return ["", ...section.headerLines, ...keptLines];
  });

  return { promptText: [...introductionLines, ...sectionLines, ""].join("\n"), leftOutNotes };
}
