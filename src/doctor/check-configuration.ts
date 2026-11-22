// Doctor: is vika.yaml there and valid, and is the environment complete?
// Each configuration problem becomes its own FAIL line, under the area it
// belongs to (a missing JIRA_API_TOKEN is a tracker problem).
import { ConfigurationError } from "../configuration/configuration-errors.js";
import { loadConfiguration, type LoadConfigurationOptions, type LoadedConfiguration } from "../configuration/load-configuration.js";
import { failCheck, passCheck, type DoctorCheck } from "./doctor-check-types.js";

function areaOfProblem(problem: string): string {
  if (/^(JIRA_|LINEAR_)/.test(problem)) return "tracker";
  if (problem.startsWith("DATABASE_URL")) return "database";
  if (problem.startsWith("webhook")) return "webhook";
  return "configuration";
}

function fixForProblem(problem: string): string {
  if (problem.startsWith("looked for ")) return "run `vika init` in your project folder, or pass --config with the path to vika.yaml";
  if (/ is not set /.test(problem)) return "add it to .env next to vika.yaml (see .env.example), or set it in the environment";
  if (problem.startsWith("DATABASE_URL")) return "use the form postgres://user:password@host:5432/database";
  if (problem.startsWith("webhook")) return "set webhook.url to a full https URL (http only for localhost); the secret goes in .env as VIKA_WEBHOOK_SECRET";
  return "edit vika.yaml (vika.example.yaml shows every setting)";
}

export function checkConfiguration(options: LoadConfigurationOptions): { checks: DoctorCheck[]; configuration: LoadedConfiguration | null } {
  try {
    const configuration = loadConfiguration(options);
    const serviceCount = Object.keys(configuration.services).length;
    return {
      checks: [passCheck("configuration", `${configuration.configurationFilePath} is valid (${serviceCount} ${serviceCount === 1 ? "service" : "services"})`)],
      configuration,
    };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    const heading = error.message.split("\n")[0]!.replace(/:$/, "");
    return {
      checks: error.problems.map((problem) => failCheck(areaOfProblem(problem), `${heading}: ${problem}`, fixForProblem(problem))),
      configuration: null,
    };
  }
}
