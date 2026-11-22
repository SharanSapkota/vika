




import { readFileAtCommit } from "../suspect-attribution/git-blame-reader.js";
import type { CodeOwners } from "./ticket-types.js";


export const CODE_OWNERS_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export interface CodeOwnersRule {
  pattern: string;
  matcher: RegExp;
  owners: string[];
}






function patternToRegex(pattern: string): RegExp {
  let body = pattern;
  
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



export function findCodeOwners(rules: CodeOwnersRule[], filePath: string): CodeOwners {
  const matchingRule = rules.findLast((rule) => rule.matcher.test(filePath));
  const owners = matchingRule?.owners ?? [];
  return {
    emails: owners.filter((owner) => !owner.startsWith("@") && owner.includes("@")),
    handles: owners.filter((owner) => owner.startsWith("@")),
  };
}



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
