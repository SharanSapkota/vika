// The dashboard: one HTML page with inline CSS and JS. No CDN, no external
// requests: it only talks to the vika server that served it.
//
// Safety: everything shown from the report (which comes from logs and
// commits, so it can contain things like "<script>") is put on the page as
// TEXT (textContent), never as HTML. The page uses no innerHTML, outerHTML,
// insertAdjacentHTML or document.write anywhere. Links from data are only
// used after checking they are http(s).
//
// The per-start token arrives in a <meta> tag; the page sends it back with
// every POST. The script and styles carry a per-start nonce that the
// Content-Security-Policy requires, so no other script can run on the page.

const PAGE_STYLE = `
  :root { color-scheme: light dark; --border: #8884; --muted: #888; --bad: #d33; --good: #2a2; }
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 70rem; padding: 1rem 1.5rem 3rem; line-height: 1.4; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 1rem; }
  h1 { margin: 0; }
  .muted { color: var(--muted); }
  .numbers { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1.5rem 0; }
  .big-number { border: 1px solid var(--border); border-radius: .5rem; padding: 1rem 1.5rem; min-width: 16rem; }
  .big-number .value { font-size: 2.5rem; font-weight: 700; }
  .label { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  section.service { border-top: 1px solid var(--border); margin-top: 2rem; padding-top: 1rem; }
  ol.timeline { display: flex; flex-wrap: wrap; gap: .5rem; list-style: none; padding: 0; }
  ol.timeline li { border: 1px solid var(--border); border-radius: .4rem; padding: .3rem .6rem; font-family: ui-monospace, monospace; font-size: .85rem; }
  ol.timeline li.failed { border: 2px solid var(--bad); color: var(--bad); font-weight: 700; }
  .card { border: 1px solid var(--border); border-left: .4rem solid var(--bad); border-radius: .5rem; padding: 1rem; margin: 1rem 0; }
  .card.medium { border-left-color: orange; } .card.low { border-left-color: var(--muted); }
  .card h3 { margin: 0 0 .5rem; word-break: break-word; }
  .card dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: .5rem 0; }
  .card dt { color: var(--muted); }
  .card dd { margin: 0; word-break: break-word; }
  code { font-family: ui-monospace, monospace; }
  button { font: inherit; padding: .3rem .9rem; cursor: pointer; }
  ul.also { margin: .3rem 0; }
`;

// Plain JavaScript that runs in the browser. Written without template
// literals so it can sit inside this TypeScript string unchanged.
const PAGE_SCRIPT = `
"use strict";
var token = document.querySelector('meta[name="vika-token"]').getAttribute("content");
var reportArea = document.getElementById("report");
var statusLine = document.getElementById("status");

// A new element with optional class and text. Text is always set as text.
function element(tagName, className, text) {
  var created = document.createElement(tagName);
  if (className) created.className = className;
  if (text !== undefined && text !== null) created.textContent = String(text);
  return created;
}

function formatPercent(fraction) { return (Math.round(fraction * 1000) / 10) + "%"; }
function formatMinutes(totalMinutes) {
  var rounded = Math.round(totalMinutes);
  if (rounded < 60) return rounded + " min";
  return Math.floor(rounded / 60) + " h " + (rounded % 60) + " min";
}
function shortSha(sha) { return sha.slice(0, 7); }

// Only http(s) links from data are ever used (never "javascript:" and friends).
function safeLink(address) {
  try {
    var parsed = new URL(address);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch (error) { return null; }
}

function bigNumber(title, valueText, detailText, label) {
  var box = element("div", "big-number");
  box.append(element("div", "", title), element("div", "value", valueText), element("div", "muted", detailText), element("div", "label", label));
  return box;
}

function renderNumbers(metrics) {
  var numbers = element("div", "numbers");
  var rate = metrics.changeFailureRate;
  var restore = metrics.medianTimeToRestore;
  numbers.append(
    bigNumber("Change failure rate", rate.value === null ? "-" : formatPercent(rate.value),
      rate.value === null ? rate.note : rate.failedDeploys + " of " + rate.judgedDeploys + " judged deploys", rate.label),
    bigNumber("Median time to restore", restore.valueMinutes === null ? "-" : formatMinutes(restore.valueMinutes),
      restore.valueMinutes === null ? restore.note + " (" + metrics.ongoingRegressions.value + " ongoing)" : "over " + restore.restoredRegressions + " restored", restore.label)
  );
  return numbers;
}

function renderTimeline(service) {
  var timeline = element("ol", "timeline");
  service.deploys.forEach(function (deploy) {
    var item = element("li", deploy.isFailed ? "failed" : deploy.status,
      shortSha(deploy.deploySha) + "  " + deploy.time.slice(0, 16).replace("T", " ") + (deploy.isFailed ? "  FAILED" : deploy.status === "checked" ? "" : "  (" + deploy.status.replace("_", " ") + ")"));
    item.title = deploy.deploySha;
    timeline.append(item);
  });
  return timeline;
}

function describeSuspect(suspect) {
  return (suspect.prNumber === null ? "commit " + shortSha(suspect.commitSha) : "PR #" + suspect.prNumber) + " by " + suspect.author.name;
}
function suspectLocation(suspect) {
  return suspect.lineNumber === null ? suspect.filePath : suspect.filePath + ":" + suspect.lineNumber;
}

function renderTicketControl(service, regression, settings) {
  var control = element("div", "ticket");
  var resultLine = element("span", "muted", "");
  if (settings.trackerType !== "none") {
    var button = element("button", "", "Create ticket for deploy " + shortSha(regression.deploySha));
    button.addEventListener("click", function () { createTicket(service.serviceName, regression.deploySha, button, resultLine); });
    control.append(button, " ", resultLine);
    return control;
  }
  // No tracker: a prefilled new-issue link when the repo is on GitHub, else nothing.
  var base = settings.gitHubNewIssueUrls[service.serviceName];
  var link = base ? safeLink(base) : null;
  if (link === null || link.hostname !== "github.com") return null;
  var top = regression.suspects[0];
  link.searchParams.set("title", service.serviceName + ": " + regression.headline);
  link.searchParams.set("body", [
    "Service: " + service.serviceName,
    "Deploy: " + regression.deploySha,
    "First seen: " + regression.firstSeen + "; " + regression.occurrences + " occurrences (log-derived)",
    "Top suspect: " + (top ? describeSuspect(top) + ", " + suspectLocation(top) + ", confidence " + top.confidence + ". Why: " + top.reason : "none (no strong suspect; may be external)"),
  ].join("\\n"));
  var anchor = element("a", "", "Open a prefilled GitHub issue");
  anchor.href = link.toString();
  anchor.rel = "noopener noreferrer";
  anchor.target = "_blank";
  control.append(anchor);
  return control;
}

function renderRegression(service, regression, settings) {
  var card = element("article", "card " + regression.severity);
  card.append(element("h3", "", regression.headline));
  var details = element("dl");
  function addDetail(name, value) { details.append(element("dt", "", name), element("dd", "", value)); }
  addDetail("Service", service.serviceName);
  addDetail("Deploy", shortSha(regression.deploySha) + (regression.deployTime ? " at " + regression.deployTime : ""));
  addDetail("First seen", regression.firstSeen);
  addDetail("Occurrences", regression.occurrences + " since the deploy (log-derived)");
  addDetail("Severity", regression.severity + (regression.kind === "new" ? ", new error" : ", spike") + (regression.restoredAt ? ", restored at " + regression.restoredAt : ", ongoing"));
  var top = regression.suspects[0];
  if (top) {
    addDetail("Top suspect", describeSuspect(top));
    addDetail("Where", suspectLocation(top));
    addDetail("Confidence", top.confidence + " (" + top.evidenceKind + ")");
    addDetail("Why", top.reason);
  } else {
    addDetail("Top suspect", regression.suspectMessage || "none");
  }
  card.append(details);
  var others = regression.suspects.slice(1);
  if (others.length > 0) {
    card.append(element("div", "muted", "Also changed in this deploy:"));
    var list = element("ul", "also");
    others.forEach(function (suspect) {
      list.append(element("li", "", describeSuspect(suspect) + ": " + suspectLocation(suspect) + ", " + suspect.confidence + ". " + suspect.reason));
    });
    card.append(list);
  }
  var control = renderTicketControl(service, regression, settings);
  if (control) card.append(control);
  return card;
}

function render(report, settings) {
  document.getElementById("as-of").textContent = report.asOf ? "Data as of " + report.asOf + " (the latest log line read)" : "No logs read yet";
  var parts = [renderNumbers(report.metrics)];
  report.services.forEach(function (service) {
    var section = element("section", "service");
    section.append(element("h2", "", service.serviceName));
    service.notes.forEach(function (note) { section.append(element("p", "muted", "Note: " + note)); });
    if (!service.isSkipped) {
      section.append(element("p", "muted", service.logEntryCount + " error/warning lines in " + service.errorGroupCount + " groups"));
      section.append(renderTimeline(service));
      if (service.regressions.length === 0) section.append(element("p", "", "No regressions."));
      service.regressions.forEach(function (regression) { section.append(renderRegression(service, regression, settings)); });
    }
    parts.push(section);
  });
  reportArea.replaceChildren.apply(reportArea, parts);
}

async function load() {
  statusLine.textContent = "Loading...";
  try {
    var answers = await Promise.all([fetch("/api/report"), fetch("/api/settings")]);
    if (!answers[0].ok || !answers[1].ok) throw new Error("the server answered " + answers[0].status);
    render(await answers[0].json(), await answers[1].json());
    statusLine.textContent = "";
  } catch (error) {
    statusLine.textContent = "Could not load the report: " + error.message;
  }
}

async function createTicket(serviceName, deploySha, button, resultLine) {
  button.disabled = true;
  resultLine.textContent = "Filing...";
  try {
    var response = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vika-Token": token },
      body: JSON.stringify({ service: serviceName, deploySha: deploySha }),
    });
    var answer = await response.json();
    resultLine.textContent = answer.message + " ";
    var link = answer.issueUrl ? safeLink(answer.issueUrl) : null;
    if (link) {
      var anchor = element("a", "", answer.issueKey || "open");
      anchor.href = link.toString();
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      resultLine.append(anchor);
    }
  } catch (error) {
    resultLine.textContent = "Could not file the ticket: " + error.message;
  } finally {
    button.disabled = false;
  }
}

document.getElementById("refresh").addEventListener("click", load);
load();
`;

// The page for one server start. The token and nonce are hex, so they are
// safe inside HTML attributes as they are.
export function renderDashboardPage(token: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="vika-token" content="${token}">
<title>vika dashboard</title>
<style nonce="${nonce}">${PAGE_STYLE}</style>
</head>
<body>
<header>
  <h1>vika</h1>
  <span id="as-of" class="muted"></span>
  <button id="refresh" type="button">Refresh</button>
  <span id="status" class="muted"></span>
</header>
<p class="muted">Shows what vika has stored; Refresh reads it again. For new data, run <code>vika run</code> on a schedule (cron) or by hand.</p>
<main id="report"></main>
<script nonce="${nonce}">${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

// Only our own inline script and style may run, and the page may only talk
// to the server that served it.
export function makeContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
