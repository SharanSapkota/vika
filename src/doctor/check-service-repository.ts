import { existsSync, statSync } from "node:fs";
import type { Deploy } from "../database/store-types.js";
import { checkShaOnBranch } from "../deploys/check-sha-on-branch.js";
import { resolveCommit, runGit } from "../deploys/run-git.js";
import { failCheck, passCheck, warnCheck, type DoctorCheck } from "./doctor-check-types.js";

export interface RepositoryCheckInput {
  serviceName: string;
  repoPath: string;
  branch: string;
  latestStoredDeploy: Deploy | null;
}

export async function checkServiceRepository(input: RepositoryCheckInput): Promise<{ checks: DoctorCheck[]; isBranchReadable: boolean }> {
  const area = `service ${input.serviceName}: repo`;
  const settingName = `services.${input.serviceName}.repo`;
  if (!existsSync(input.repoPath) || !statSync(input.repoPath).isDirectory()) {
    return { checks: [failCheck(area, `${input.repoPath} does not exist or is not a folder`, `set ${settingName} to the path of the service's git checkout`)], isBranchReadable: false };
  }
  const gitDirectory = await runGit(input.repoPath, ["rev-parse", "--git-dir"]);
  if (gitDirectory.exitCode !== 0) {
    return { checks: [failCheck(area, `${input.repoPath} is not a git repository`, `set ${settingName} to a git checkout (git clone your repo there)`)], isBranchReadable: false };
  }

  const checks: DoctorCheck[] = [passCheck(area, `${input.repoPath} is a git repository`)];
  if ((await resolveCommit(input.repoPath, input.branch)) === undefined) {
    checks.push(
      failCheck(area, `branch "${input.branch}" does not exist in ${input.repoPath}`, `set services.${input.serviceName}.branch to your production branch, or run git fetch in the checkout`),
    );
    return { checks, isBranchReadable: false };
  }
  checks.push(passCheck(area, `branch "${input.branch}" exists`));

  const headSha = await resolveCommit(input.repoPath, "HEAD");
  if (headSha !== undefined) {
    const headCheck = await checkShaOnBranch(input.repoPath, headSha, input.branch);
    checks.push(
      headCheck.onBranch
        ? passCheck(area, `the checkout (HEAD ${headSha.slice(0, 7)}) is on "${input.branch}"`)
        : warnCheck(area, `the checkout (HEAD ${headSha.slice(0, 7)}) is not on "${input.branch}"`, `nothing breaks: vika always reads "${input.branch}", not the checkout. To silence this, check out "${input.branch}"`),
    );
  }

  if (input.latestStoredDeploy !== null) {
    const deployCheck = await checkShaOnBranch(input.repoPath, input.latestStoredDeploy.sha, input.branch);
    checks.push(
      deployCheck.onBranch
        ? passCheck(area, `the latest stored deploy (${input.latestStoredDeploy.sha.slice(0, 7)}) is on "${input.branch}"`)
        : failCheck(area, `the latest stored deploy: ${deployCheck.reason}`, `run git fetch in ${input.repoPath}, or check that mark-deploy gets the sha from "${input.branch}"`),
    );
  }
  return { checks, isBranchReadable: true };
}
