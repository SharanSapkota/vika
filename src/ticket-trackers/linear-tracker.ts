// Linear, through its GraphQL API. The API key goes in the Authorization
// header as it is, with NO "Bearer" (Linear's personal API keys work that
// way). Issues are created without a state, so Linear puts them in Backlog.
//
// Linear labels are objects, not strings: each label is looked up by name,
// created if missing, and its id is cached for the rest of the run.
import { renderMarkdown } from "../ticketing/render-ticket-text.js";
import { sendTrackerRequest, TrackerError } from "./send-tracker-request.js";
import { TRACKER_TIMEOUT_MS, type FetchFunction, type TicketTracker } from "./tracker-types.js";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearTrackerOptions {
  apiKey: string; // LINEAR_API_KEY
  teamKey: string; // tracker.team, e.g. "ENG"
  fetchFunction: FetchFunction;
  timeoutMs?: number;
  secrets: string[];
}

interface GraphqlAnswer {
  data?: Record<string, unknown>;
  errors?: { message?: string; extensions?: { code?: string; type?: string } }[];
}

export function createLinearTracker(options: LinearTrackerOptions): TicketTracker {
  const labelIdsByName = new Map<string, string>();
  let teamId: string | undefined;

  async function runGraphql<Data>(query: string, variables: Record<string, unknown>): Promise<Data> {
    const answer = (await sendTrackerRequest({
      trackerName: "Linear",
      credentialsHint: "LINEAR_API_KEY",
      fetchFunction: options.fetchFunction,
      url: LINEAR_API_URL,
      method: "POST",
      headers: { Authorization: options.apiKey },
      body: { query, variables },
      timeoutMs: options.timeoutMs ?? TRACKER_TIMEOUT_MS,
      secrets: options.secrets,
    })) as GraphqlAnswer;
    // Linear reports some failures inside a 200 answer.
    const firstError = answer.errors?.[0];
    if (firstError !== undefined) {
      const code = `${firstError.extensions?.code ?? ""} ${firstError.extensions?.type ?? ""}`.toLowerCase();
      if (code.includes("ratelimited")) throw new TrackerError("Linear is rate-limiting vika. Nothing was retried; run again in a few minutes.", 429);
      if (code.includes("authentication")) throw new TrackerError("Linear rejected vika's credentials. Check LINEAR_API_KEY.", 401);
      throw new TrackerError(`Linear refused the request (${firstError.message ?? "no details"}).`, null);
    }
    return (answer.data ?? {}) as Data;
  }

  async function findTeamId(): Promise<string> {
    if (teamId !== undefined) return teamId;
    const data = await runGraphql<{ teams: { nodes: { id: string }[] } }>(
      "query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }",
      { key: options.teamKey },
    );
    const foundId = data.teams.nodes[0]?.id;
    if (foundId === undefined) throw new TrackerError(`Linear has no team with key "${options.teamKey}" (tracker.team in vika.yaml).`, 404);
    teamId = foundId;
    return foundId;
  }

  // The id of the label with this name, created first if it doesn't exist.
  async function findOrCreateLabelId(labelName: string): Promise<string> {
    const cachedId = labelIdsByName.get(labelName);
    if (cachedId !== undefined) return cachedId;
    const data = await runGraphql<{ issueLabels: { nodes: { id: string }[] } }>(
      "query LabelByName($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id } } }",
      { name: labelName },
    );
    let labelId = data.issueLabels.nodes[0]?.id;
    if (labelId === undefined) {
      const created = await runGraphql<{ issueLabelCreate: { success: boolean; issueLabel?: { id: string } } }>(
        "mutation CreateLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }",
        { input: { name: labelName } },
      );
      labelId = created.issueLabelCreate.issueLabel?.id;
      if (labelId === undefined) throw new TrackerError(`Linear did not create the label "${labelName}".`, null);
    }
    labelIdsByName.set(labelName, labelId);
    return labelId;
  }

  return {
    trackerType: "linear",

    async findUserByEmail(email) {
      const data = await runGraphql<{ users: { nodes: { id: string; name: string }[] } }>(
        "query UserByEmail($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name } } }",
        { email },
      );
      const user = data.users.nodes[0];
      return user === undefined ? undefined : { id: user.id, name: user.name };
    },

    async createIssue(draft, assigneeId) {
      const labelIds: string[] = [];
      for (const labelName of draft.labels) labelIds.push(await findOrCreateLabelId(labelName));
      const data = await runGraphql<{ issueCreate: { success: boolean; issue?: { identifier: string; url: string } } }>(
        "mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
        {
          input: {
            teamId: await findTeamId(),
            title: draft.title,
            description: renderMarkdown(draft.bodySections),
            labelIds,
            ...(assigneeId === undefined ? {} : { assigneeId }),
          },
        },
      );
      const issue = data.issueCreate.issue;
      if (!data.issueCreate.success || issue === undefined) throw new TrackerError("Linear did not create the issue.", null);
      return { issueKey: issue.identifier, issueUrl: issue.url };
    },

    async addComment(issueKey, text) {
      // Comments need the issue's id, not its "ENG-45" identifier.
      const found = await runGraphql<{ issue: { id: string } | null }>("query IssueId($id: String!) { issue(id: $id) { id } }", { id: issueKey });
      if (found.issue === null) throw new TrackerError(`Linear has no issue ${issueKey}.`, 404);
      await runGraphql("mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", {
        input: { issueId: found.issue.id, body: text },
      });
    },

    async checkCredentials() {
      const data = await runGraphql<{ viewer: { id: string; name: string } }>("query Viewer { viewer { id name } }", {});
      return { name: data.viewer.name };
    },

    async findIssueByLabel(label) {
      const data = await runGraphql<{ issues: { nodes: { identifier: string; url: string }[] } }>(
        "query IssueByLabel($label: String!, $teamId: ID!) { issues(first: 1, filter: { labels: { name: { eq: $label } }, team: { id: { eq: $teamId } } }) { nodes { identifier url } } }",
        { label, teamId: await findTeamId() },
      );
      const issue = data.issues.nodes[0];
      return issue === undefined ? undefined : { issueKey: issue.identifier, issueUrl: issue.url };
    },
  };
}
