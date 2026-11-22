// In-memory fake Jira and Linear servers, as fetch functions. Tests pass
// them to the tracker clients, so no test ever touches the network, and
// every request is recorded so tests can check exactly what was sent.
import type { FetchFunction } from "../../src/ticket-trackers/tracker-types.js";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeServerOptions {
  failWithStatus?: number; // every request answers with this HTTP status
  failureBody?: string; // what a failing answer says (may echo a token, to test masking)
  createDelayMs?: number; // creating an issue takes this long (to overlap runs)
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const wait = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));

function recordRequest(requests: RecordedRequest[], url: string, init: RequestInit): RecordedRequest {
  const request = {
    method: init.method ?? "GET",
    url,
    headers: { ...(init.headers as Record<string, string>) },
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
  };
  requests.push(request);
  return request;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export interface FakeJiraIssue {
  key: string;
  fields: { summary: string; labels: string[]; description: unknown; assignee?: { accountId: string } };
}

export interface FakeJira {
  fetchFunction: FetchFunction;
  requests: RecordedRequest[];
  issues: FakeJiraIssue[];
  comments: { issueKey: string; body: unknown }[];
}

export function createFakeJira(
  users: { accountId: string; emailAddress: string; displayName: string }[] = [],
  options: FakeServerOptions & { existingIssues?: FakeJiraIssue[] } = {},
): FakeJira {
  const requests: RecordedRequest[] = [];
  const issues: FakeJiraIssue[] = [...(options.existingIssues ?? [])];
  const comments: { issueKey: string; body: unknown }[] = [];

  const fetchFunction: FetchFunction = async (url, init) => {
    const request = recordRequest(requests, url, init);
    if (options.failWithStatus !== undefined) return new Response(options.failureBody ?? "", { status: options.failWithStatus });
    const { pathname, searchParams } = new URL(url);

    if (request.method === "GET" && pathname === "/rest/api/3/myself") {
      return jsonResponse({ accountId: "acc-vika-bot", displayName: "vika bot", emailAddress: "ops@example.com" });
    }
    if (request.method === "GET" && pathname === "/rest/api/3/user/search") {
      const query = searchParams.get("query") ?? "";
      return jsonResponse(users.filter((user) => user.emailAddress === query).map((user) => ({ ...user, accountType: "atlassian" })));
    }
    if (request.method === "POST" && pathname === "/rest/api/3/issue") {
      if (options.createDelayMs !== undefined) await wait(options.createDelayMs);
      const key = `OPS-${issues.length + 1}`;
      issues.push({ key, fields: (request.body as { fields: FakeJiraIssue["fields"] }).fields });
      return jsonResponse({ id: String(issues.length), key, self: `${new URL(url).origin}/rest/api/3/issue/${key}` }, 201);
    }
    const commentMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(pathname);
    if (request.method === "POST" && commentMatch) {
      comments.push({ issueKey: decodeURIComponent(commentMatch[1]!), body: (request.body as { body: unknown }).body });
      return jsonResponse({ id: String(comments.length) }, 201);
    }
    if (request.method === "POST" && pathname === "/rest/api/3/search/jql") {
      const label = /labels = "([^"]+)"/.exec((request.body as { jql: string }).jql)?.[1];
      const found = issues.filter((issue) => issue.fields.labels.includes(label ?? ""));
      return jsonResponse({ issues: found.slice(0, 1).map((issue) => ({ key: issue.key })) });
    }
    return jsonResponse({ errorMessages: [`fake Jira does not know ${request.method} ${pathname}`] }, 404);
  };

  return { fetchFunction, requests, issues, comments };
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

export interface FakeLinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  labelIds: string[];
  assigneeId?: string;
}

export interface FakeLinear {
  fetchFunction: FetchFunction;
  requests: RecordedRequest[];
  issues: FakeLinearIssue[];
  labels: { id: string; name: string }[];
  comments: { issueId: string; body: string }[];
}

export function createFakeLinear(
  users: { id: string; email: string; name: string }[] = [],
  options: FakeServerOptions & { existingLabels?: { id: string; name: string }[]; graphqlErrorCode?: string } = {},
): FakeLinear {
  const requests: RecordedRequest[] = [];
  const issues: FakeLinearIssue[] = [];
  const labels = [...(options.existingLabels ?? [])];
  const comments: { issueId: string; body: string }[] = [];
  const team = { id: "team-1", key: "ENG" };

  const fetchFunction: FetchFunction = async (url, init) => {
    const request = recordRequest(requests, url, init);
    if (options.failWithStatus !== undefined) return new Response(options.failureBody ?? "", { status: options.failWithStatus });
    if (options.graphqlErrorCode !== undefined) {
      return jsonResponse({ errors: [{ message: "refused", extensions: { code: options.graphqlErrorCode } }] });
    }
    const { query, variables } = request.body as { query: string; variables: Record<string, any> };
    const operationName = /^(?:query|mutation) (\w+)/.exec(query)?.[1];

    switch (operationName) {
      case "Viewer":
        return jsonResponse({ data: { viewer: { id: "user-vika", name: "vika bot" } } });
      case "TeamByKey":
        return jsonResponse({ data: { teams: { nodes: variables.key === team.key ? [{ id: team.id }] : [] } } });
      case "UserByEmail":
        return jsonResponse({ data: { users: { nodes: users.filter((user) => user.email === variables.email).map(({ id, name }) => ({ id, name })) } } });
      case "LabelByName":
        return jsonResponse({ data: { issueLabels: { nodes: labels.filter((label) => label.name === variables.name).map(({ id }) => ({ id })) } } });
      case "CreateLabel": {
        const label = { id: `label-${labels.length + 1}`, name: variables.input.name as string };
        labels.push(label);
        return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: label.id } } } });
      }
      case "CreateIssue": {
        if (options.createDelayMs !== undefined) await wait(options.createDelayMs);
        const identifier = `ENG-${issues.length + 1}`;
        const issue = { id: `issue-${issues.length + 1}`, identifier, url: `https://linear.app/example/issue/${identifier}`, ...variables.input };
        issues.push(issue);
        return jsonResponse({ data: { issueCreate: { success: true, issue: { identifier, url: issue.url } } } });
      }
      case "IssueId": {
        const issue = issues.find((candidate) => candidate.identifier === variables.id || candidate.id === variables.id);
        return jsonResponse({ data: { issue: issue === undefined ? null : { id: issue.id } } });
      }
      case "AddComment":
        comments.push({ issueId: variables.input.issueId, body: variables.input.body });
        return jsonResponse({ data: { commentCreate: { success: true } } });
      case "IssueByLabel": {
        const labelIds = labels.filter((label) => label.name === variables.label).map((label) => label.id);
        const found = issues.filter((issue) => issue.labelIds.some((labelId) => labelIds.includes(labelId)));
        return jsonResponse({ data: { issues: { nodes: found.slice(0, 1).map(({ identifier, url }) => ({ identifier, url })) } } });
      }
      default:
        return jsonResponse({ errors: [{ message: `fake Linear does not know ${operationName}` }] });
    }
  };

  return { fetchFunction, requests, issues, labels, comments };
}

// A fetch function that fails the test if anything calls it.
export function createForbiddenFetch(calls: string[]): FetchFunction {
  return async (url) => {
    calls.push(url);
    throw new Error(`network call in a test: ${url}`);
  };
}
