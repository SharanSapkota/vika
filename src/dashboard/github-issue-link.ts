import { runGit } from "../deploys/run-git.js";

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
    return null; 
  }
}
