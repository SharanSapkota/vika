// Jira Cloud (REST API v3). Basic auth with JIRA_EMAIL and JIRA_API_TOKEN;
// descriptions and comments in ADF. Issues go into the project from
// vika.yaml (tracker.project), with tracker.issueType (default "Bug").
import { sectionsToAdf, textToAdf } from "./jira-document.js";
import { sendTrackerRequest, TrackerError } from "./send-tracker-request.js";
import { TRACKER_TIMEOUT_MS, type FetchFunction, type TicketTracker, type TrackerIssue } from "./tracker-types.js";

export const DEFAULT_JIRA_ISSUE_TYPE = "Bug";

export interface JiraTrackerOptions {
  baseUrl: string; // JIRA_BASE_URL, e.g. https://example.atlassian.net
  email: string; // JIRA_EMAIL
  apiToken: string; // JIRA_API_TOKEN
  projectKey: string; // tracker.project
  issueType?: string; // tracker.issueType, default "Bug"
  fetchFunction: FetchFunction;
  timeoutMs?: number;
  secrets: string[];
}

interface JiraUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
  accountType?: string;
}

export function createJiraTracker(options: JiraTrackerOptions): TicketTracker {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
  const send = (method: "GET" | "POST", path: string, body?: unknown) =>
    sendTrackerRequest({
      trackerName: "Jira",
      credentialsHint: "JIRA_EMAIL and JIRA_API_TOKEN",
      fetchFunction: options.fetchFunction,
      url: `${baseUrl}${path}`,
      method,
      headers: { Authorization: authorization },
      ...(body === undefined ? {} : { body }),
      timeoutMs: options.timeoutMs ?? TRACKER_TIMEOUT_MS,
      secrets: options.secrets,
    });
  const issueUrl = (issueKey: string) => `${baseUrl}/browse/${issueKey}`;

  return {
    trackerType: "jira",

    async findUserByEmail(email) {
      const users = (await send("GET", `/rest/api/3/user/search?query=${encodeURIComponent(email)}`)) as JiraUser[];
      // Real people only (not apps). Jira may hide email addresses for
      // privacy; then a single match on the query is taken as the person.
      const people = (Array.isArray(users) ? users : []).filter((user) => user.accountType === undefined || user.accountType === "atlassian");
      const exactMatch = people.find((user) => user.emailAddress?.toLowerCase() === email.toLowerCase());
      const match = exactMatch ?? (people.length === 1 && people[0]!.emailAddress === undefined ? people[0] : undefined);
      return match === undefined ? undefined : { id: match.accountId, name: match.displayName ?? email };
    },

    async createIssue(draft, assigneeId) {
      const created = (await send("POST", "/rest/api/3/issue", {
        fields: {
          project: { key: options.projectKey },
          issuetype: { name: options.issueType ?? DEFAULT_JIRA_ISSUE_TYPE },
          summary: draft.title,
          description: sectionsToAdf(draft.bodySections),
          labels: draft.labels,
          ...(assigneeId === undefined ? {} : { assignee: { accountId: assigneeId } }),
        },
      })) as { key?: string };
      if (typeof created.key !== "string") throw new TrackerError("Jira created the issue but did not say its key.", null);
      return { issueKey: created.key, issueUrl: issueUrl(created.key) };
    },

    async addComment(issueKey, text) {
      await send("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, { body: textToAdf(text) });
    },

    async checkCredentials() {
      const myself = (await send("GET", "/rest/api/3/myself")) as { displayName?: string; emailAddress?: string };
      return { name: myself.displayName ?? myself.emailAddress ?? options.email };
    },

    async findIssueByLabel(label): Promise<TrackerIssue | undefined> {
      // Labels never contain quotes (they are built by vika), but escape anyway.
      const jql = `project = "${options.projectKey.replace(/"/g, '\\"')}" AND labels = "${label.replace(/"/g, '\\"')}" ORDER BY created ASC`;
      const found = (await send("POST", "/rest/api/3/search/jql", { jql, fields: ["key"], maxResults: 1 })) as { issues?: { key: string }[] };
      const issueKey = found.issues?.[0]?.key;
      return issueKey === undefined ? undefined : { issueKey, issueUrl: issueUrl(issueKey) };
    },
  };
}
