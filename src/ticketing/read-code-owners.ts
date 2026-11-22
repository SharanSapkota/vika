// Who owns a file, according to the repo's CODEOWNERS at the deployed sha.
//
// Reading is read-only git (git show, through readFileAtCommit). The
// matcher is pure and follows GitHub's rules: patterns work like
// .gitignore, and when several match, the LAST one in the file wins.
import { readFileAtCommit } from "../suspect-attribution/git-blame-reader.js";
import type { CodeOwners } from "./ticket-types.js";

// Where GitHub looks, in the order it looks; the first file found is used.
export const CODE_OWNERS_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export interface CodeOwnersRule {
  pattern: string;
  matcher: RegExp;
  owners: string[];
}

// Turns one CODEOWNERS pattern into a regex over repo-relative paths.
//   "*.js"        any .js file, at any depth
//   "/build/"     the build folder at the repo root, and everything in it
//   "docs/*"      files directly in a docs folder (a "/" inside anchors it to the root)
//   "apps/**/x"   "**" spans any number of folders
function patternToRegex(pattern: string): RegExp {
  let body = pattern;
  // A "/" at the start or in the middle ties the pattern to the repo root.
  const isAnchored = body.startsWith("/") || body.slice(0, -1).includes("/");
  body = body.replace(/^\//, "");
  const isFolderOnly = body.endsWith("/");
  body = body.replace(/\/$/, "");

  let regexBody = "";
  for (let characterIndex = 0; characterIndex < body.length; characterIndex++) {
    const character = body[characterIndex]!;
    if (body.startsWith("**/", characterIndex)) {
      regexBody += "(?:.*/)?";
      characterIndex += 2;
    } else if (body.startsWith("**", characterIndex)) {
      regexBody += ".*";
      characterIndex += 1;
    } else if (character === "*") {
      regexBody += "[^/]*";
    } else if (character === "?") {
      regexBody += "[^/]";
    } else {
      regexBody += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const prefix = isAnchored ? "^" : "^(?:.*/)?";
  // A folder pattern covers everything inside; a plain one also matches a
  // folder of that name (and so everything inside it).
  const suffix = isFolderOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${regexBody}${suffix}`);
}

export function parseCodeOwners(fileText: string): CodeOwnersRule[] {
  const rules: CodeOwnersRule[] = [];
  for (const rawLine of fileText.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern: pattern!, matcher: patternToRegex(pattern!), owners });
  }
  return rules;
}

// The owners of one file: the last matching rule wins. A matching rule with
// no owners means "nobody owns this".
export function findCodeOwners(rules: CodeOwnersRule[], filePath: string): CodeOwners {
  const matchingRule = rules.findLast((rule) => rule.matcher.test(filePath));
  const owners = matchingRule?.owners ?? [];
  return {
    emails: owners.filter((owner) => !owner.startsWith("@") && owner.includes("@")),
    handles: owners.filter((owner) => owner.startsWith("@")),
  };
}

// The rules from the first CODEOWNERS file found at the deployed sha, or
// none if the repo has no CODEOWNERS.
export async function readCodeOwnersRules(repoPath: string, deploySha: string): Promise<CodeOwnersRule[]> {
  for (const location of CODE_OWNERS_LOCATIONS) {
    const fileText = await readFileAtCommit(repoPath, deploySha, location);
    if (fileText !== undefined) return parseCodeOwners(fileText);
  }
  return [];
}

export async function readCodeOwnersForFile(repoPath: string, deploySha: string, filePath: string): Promise<CodeOwners> {
  return findCodeOwners(await readCodeOwnersRules(repoPath, deploySha), filePath);
}
