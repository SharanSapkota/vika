// When no tracker is configured, the dashboard can still offer a prefilled
// "new GitHub issue" link, if the service's repo lives on github.com.
// Reading the remote is read-only git (git remote get-url origin).
import { runGit } from "../deploys/run-git.js";

// "https://github.com/acme/shop(.git)", "git@github.com:acme/shop.git" or
// "ssh://git@github.com/acme/shop.git" -> "https://github.com/acme/shop/issues/new".
// Anything else (GitLab, a local path, ...) -> null.
export function makeGitHubNewIssueUrl(remoteUrl: string): string | null {
  const repositoryMatch =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!repositoryMatch) return null;
  return `https://github.com/${repositoryMatch[1]}/${repositoryMatch[2]}/issues/new`;
}

export async function readGitHubNewIssueUrl(repoPath: string): Promise<string | null> {
  try {
    const remote = await runGit(repoPath, ["remote", "get-url", "origin"]);
    return remote.exitCode === 0 ? makeGitHubNewIssueUrl(remote.stdout) : null;
  } catch {
    return null; // not a repo, or git can't run there: no link
  }
}
