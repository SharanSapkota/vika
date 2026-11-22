# Vika

# Vika

Vika reads your server logs and your git history. It finds errors that **started right after a deploy**, and tells you which commit and which person are the most likely **suspect**. It can also create a ticket in Linear or Jira *ON HUMAN APPROVAL *.

It runs **inside your own environment**. Your logs and source code never leave your machine. It works for one app (monolith) or many apps (microservices).


---

## What it does?

Your team deploys new code. A few minutes later, a new error shows up in the logs. Normally someone has to dig through thousands of log lines and the git history to find out which change caused it.

Vika does that digging for you:

1. It reads the new log lines.
2. It groups similar errors together. ("Timeout for user 123" and "Timeout for user 456" are the same error.)
3. It knows when each deploy happened.
4. It flags an error group that did not exist before a deploy and started soon after it.
5. It looks at the crash location (from the stack trace) and uses `git blame` and `git log` to find which commit in that deploy probably caused it.
6. It shows the suspect commit, the pull request number, the author, and a confidence level.

Errors that happen every day (like a database timeout) are **not** flagged.

Vika always says "suspect", never "culprit". It can be wrong. It tells you how sure it is, and it says "no strong suspect" when it is not sure.

---

## Install

```sh
npm install -g vika-cli
```

The package is called `vika-cli`. The command you type is `vika`.

You can also run it without installing: `npx vika-cli report`.

---

## Setup in 5 steps

### 1. Create a folder for Vika's settings

```sh
mkdir vika-live && cd vika-live
```

### 2. Generate a starter config

```sh
vika init
```

This writes two files here: `vika.yaml` and `.env.example`. It looks around for a git repo and log files and fills in what it finds. It never overwrites existing files.

### 3. Add your secrets to `.env`

```sh
cp .env.example .env
```

Open `.env` and set:

```
VIKA_DATABASE_URL=postgres://user:password@host:5432/vika
```

Use a **direct** database connection, not a connection pooler (for example, on Neon, not the host with `-pooler` in its name). Vika uses database locks, and poolers can break them.

Never commit `.env` to git.

### 4. Edit `vika.yaml`

Tell Vika where your repo and logs are. Example:

```yaml
services:
  myapp:
    repo: /srv/repos/myapp
    logs: /var/log/myapp/app.log
    branch: main
    deploys:
      source: marker
```

All settings are explained below.

### 5. Check everything

```sh
vika doctor
```

`doctor` checks your config, database, repo, logs and tracker. It prints OK, WARN or FAIL for each, and tells you how to fix every problem. It changes nothing. Fix every FAIL before you continue.

---


## Run it all the time

Vika does not run by itself. You schedule `vika run`. The simplest way is cron, every 10 minutes:

```
*/10 * * * * cd /path/to/vika-live && /usr/local/bin/vika run >> vika.log 2>&1
```

(Run `which vika` to find the full path. Cron has a very small environment, so full paths are safer.)

Each time, `vika run` reads **only the new** log lines, updates the counts, looks for new errors after deploys, and prints a report. It never asks questions, so it is safe in cron.

Exit codes for `vika run`: `0` = fine, `1` = something failed, `2` = another run is already in progress.

`vika run` does **not** create tickets by itself, because no person is there to approve.

---

## Commands

| Command | What it does | Who runs it |
|---|---|---|
| `vika init` | Writes a starter `vika.yaml` and `.env.example` | You, once |
| `vika doctor` | Checks that your setup is correct. Changes nothing. | You, once, and when something breaks |
| `vika mark-deploy` | Records "this version went live" | Your deploy script |
| `vika run` | Reads new logs, finds problems, prints a report | Cron, every few minutes |
| `vika report` | Shows what Vika found. Creates no tickets. | You, when you want to look |
| `vika report --create-tickets` | Shows what Vika found, then asks before creating each ticket | You, when you want tickets |
| `vika serve` | Opens a local web page with the same information | You, when you want to look |

Most commands accept `--config path/to/vika.yaml`. Without it, Vika looks for `vika.yaml` in the current folder.

When Vika asks `Create ticket? [y]es / [n]o / [e]dit title`, type **one letter**: `y`, `n` or `e`. Anything else counts as "no".

---

## Example message that it shows

```
Regressions: 1
  1. NEW error after deploy f822ffb   severity: high
     TypeError: Cannot read properties of undefined (reading 'amount')
     first seen 2026-03-06T14:04:07Z; 124 times since
     Suspects:
       1) PR #812  commit b5f679e  Tomas Ortega
          src/orders/service.ts:22   confidence: high
          why: Line 22, where the error is thrown, was last changed by this commit.
Change failure rate (log-derived): 25% (1 of 4 judged deploys)
Median time to restore (log-derived): not enough data
```

- **Change failure rate** = the share of deploys that caused a new error. 
- **Median time to restore** = how long those errors lasted.
- Both are labeled **log-derived**: they come from your logs, not from an incident system, so treat them as estimates.

---

## The dashboard

```sh
vika serve
```

Open `http://127.0.0.1:4173`. It listens on your own computer only. It shows stored data, so keep `vika run` on a schedule to feed it. On a remote server, use an SSH tunnel:

```sh
ssh -L 4173:127.0.0.1:4173 user@server
```

---

## All settings in `vika.yaml`

```yaml
services:
  api:                                    # service name: lowercase letters, digits, dashes
    repo: /srv/repos/api                  # path to your local git clone (required)
    logs: /var/log/acme/api.log           # a file path ...
    # logs: { command: "docker logs --since=10m --timestamps api 2>&1" }   # ... or a command
    branch: main                          # production branch (default: main)
    pathMap:                              # fix paths in stack traces (optional)
      /app/src: src
    pathPrefix: services/api              # monorepo: folder this service lives in (optional)
    deploys:
      source: marker                      # "marker" or "merges"

tracker:                                  # where tickets go
  type: linear                            # linear, jira, or none (default: none)
  team: ENG                               # Linear team key

redact: [email, jwt, ip, cardlike]        # what to hide before storing (default: all four)

webhook:                                  # optional: notify another system
  url: https://example.com/hook
  secret: some-shared-secret
```

For Jira use:

```yaml
tracker:
  type: Linear
  project: OPS. 
  issueType: Bug        # optional, default Bug
```

Unknown keys are rejected on purpose, so a typo like `brnach:` gives an error instead of being ignored.

### Environment variables (`.env`)

| Variable | When needed |
|---|---|
| `DATABASE_URL` | Always |
| `LINEAR_API_KEY` | If the tracker is Linear |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | If the tracker is Jira |

### Logs: a file or a command

Vika can read logs from a **file** or from the **output of a command**. Use a command when your software does not write a log file.

| Where your logs are | `logs:` setting |
|---|---|
| A file | `/var/log/app.log` |
| Docker container | `{ command: "docker logs --since=10m --timestamps myapp 2>&1" }` |
| Kubernetes | `{ command: "kubectl logs deploy/myapp --since=10m --timestamps" }` |
| systemd service | `{ command: "journalctl -u myapp --since '10 minutes ago' -o short-iso --no-pager" }` |
| pm2 | `{ command: "pm2 logs myapp --lines 500 --nostream" }` |
| Another server | `{ command: "ssh deploy@host 'docker logs --since=10m --timestamps app 2>&1'" }` |

Rules for commands:

- Every line needs a **timestamp**. Use `--timestamps` for Docker and `-o short-iso` for journalctl.
- Include **errors**. Docker prints errors on stderr, so keep the `2>&1`.
- If you can type the command in your terminal and see logs, Vika can read it.
- Vika only runs the command you wrote. It never builds commands from log content.

Supported log formats: JSON lines, plain text with timestamps, and nginx (5xx responses count as errors). Stack traces that span several lines are joined into one error.

### `pathMap`: when stack-trace paths do not match your repo

Inside Docker your app may run from `/app/src/orders/service.ts`, but in your repo the file is `src/orders/service.ts`. Tell Vika how to translate:

```yaml
pathMap:
  /app/src: src
```

`vika doctor` suggests a `pathMap` when it sees a mismatch.



## Creating tickets

1. Add the tracker settings to `vika.yaml` and the token to `.env`.
2. Run `vika doctor` and check the tracker line says OK.
3. Run `vika report --create-tickets` and answer `y`.

What you get:

- **One ticket per bad deploy**, not one per error.
- It lists the suspect (PR, author, file and line, confidence), other commits in that deploy, log locations, and up to 3 redacted examples.
- It is assigned to the suspect's author when Vika can match their git email to a Linear or Jira user. For bots and `noreply` emails it tries the CODEOWNERS file, then leaves the ticket unassigned and writes the author's name in the description.
- **Never twice.** Running again says "Already filed". If more error groups appear later for the same deploy, Vika adds a comment instead of a new ticket.

---


## Start Postgres

```sh
docker compose up -d --wait db          # dev database on localhost:5433
```

## Run tests

Tests use a separate, throwaway database on port 5434. Its data lives in memory,
so it is wiped whenever the container stops.

```sh
docker compose --profile test up -d --wait db-test
npm test
docker compose --profile test rm -sf db-test  
```

## Other scripts

```sh
npm run typecheck   # type-check src and tests
npm run build       # compile src/ to dist/
node dist/cli.js --help
```
