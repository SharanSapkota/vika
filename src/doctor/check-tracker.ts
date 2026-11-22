import { hideSecrets } from "../configuration/hide-secrets.js";
import type { TicketTracker } from "../ticket-trackers/tracker-types.js";
import { failCheck, passCheck, type DoctorCheck } from "./doctor-check-types.js";

const AREA = "tracker";

export async function checkTracker(tracker: TicketTracker | null, secrets: string[]): Promise<DoctorCheck[]> {
  if (tracker === null) return [passCheck(AREA, 'tracker.type is "none": no tickets will be filed (that is fine)')];
  const trackerName = tracker.trackerType === "jira" ? "Jira" : "Linear";
  const credentialNames = tracker.trackerType === "jira" ? "JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN" : "LINEAR_API_KEY";
  try {
    const user = await tracker.checkCredentials();
    return [passCheck(AREA, `${trackerName} accepts the credentials (logged in as ${user.name})`)];
  } catch (error) {
    return [failCheck(AREA, hideSecrets(error instanceof Error ? error.message : String(error), secrets), `check ${credentialNames} in .env`)];
  }
}
