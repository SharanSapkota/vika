import type { DeploySource } from "../configuration/configuration-schema.js";
import { passCheck, warnCheck, type DoctorCheck } from "./doctor-check-types.js";

export interface DeploysCheckInput {
  serviceName: string;
  source: DeploySource;
  branch: string;
  storedDeployCount: number | null;
}

export function checkDeploys(input: DeploysCheckInput): DoctorCheck[] {
  const area = `service ${input.serviceName}: deploys`;
  switch (input.source) {
    case "marker":
      if (input.storedDeployCount === null) return [warnCheck(area, "could not count the stored deploys (the database is not reachable)", "fix the database first")];
      if (input.storedDeployCount === 0) {
        return [
          warnCheck(
            area,
            "deploys.source is marker, but no deploy has been recorded yet, so nothing can be judged",
            `add this to the end of your deploy script: vika mark-deploy --service ${input.serviceName} --sha "$(git rev-parse HEAD)" --time "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
          ),
        ];
      }
      return [passCheck(area, `${input.storedDeployCount} ${input.storedDeployCount === 1 ? "deploy" : "deploys"} recorded with mark-deploy`)];
    case "merges":
      return [
        warnCheck(
          area,
          `deploys.source is merges: every commit on "${input.branch}" counts as a deploy at its commit time. That is rough: real deploy times are often later`,
          "for accurate results, use deploys: { source: marker } and run vika mark-deploy from your deploy script",
        ),
      ];
    default:
      return [warnCheck(area, `deploys.source "${input.source}" is not supported yet`, "use marker (recommended) or merges")];
  }
}
