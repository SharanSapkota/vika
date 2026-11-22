// The tracker client for the configuration, or null for tracker type "none".
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import { createJiraTracker } from "./jira-tracker.js";
import { createLinearTracker } from "./linear-tracker.js";
import type { FetchFunction, TicketTracker } from "./tracker-types.js";

export function createTracker(configuration: LoadedConfiguration, fetchFunction: FetchFunction, secrets: string[]): TicketTracker | null {
  const { tracker, trackerCredentials } = configuration;
  if (tracker.type === "jira" && trackerCredentials.type === "jira") {
    return createJiraTracker({
      baseUrl: trackerCredentials.baseUrl,
      email: trackerCredentials.email,
      apiToken: trackerCredentials.apiToken,
      projectKey: tracker.project,
      issueType: tracker.issueType,
      fetchFunction,
      secrets,
    });
  }
  if (tracker.type === "linear" && trackerCredentials.type === "linear") {
    return createLinearTracker({ apiKey: trackerCredentials.apiKey, teamKey: tracker.team, fetchFunction, secrets });
  }
  return null;
}
