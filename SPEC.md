# Prose Skill Comparer — Spec

Source of truth: https://claude.ai/artifact/1A3urnUVmeBDcvGSdgFpi3 (exported Nov 14, 2026)

## Overview and goals

A hosted web app that runs one prompt against several sets of SKILL.md files and shows the outputs side by side, with a check on whether each skill actually triggered. It turns the Humanizing Skills Bake-off page into something anyone can generate and share.

Goals:

- Compare skills and **combinations** of skills on the same prompt, model and harness.
- Show whether each skill was invoked, taken from the harness's tool-call events, not guessed from the text.
- Keep every run permanently, pinned to exact skill commit SHAs, model and harness version, so a result stays reproducible.
- Keep spend bounded: the backend holds one key, `OPENROUTER_TOKEN`, and submissions shut off when the budget is spent.

Non-goals for v1:

- Automated judging or scoring. Readers judge the prose.
- Skills that need to run scripts, edit files or use MCP. The harness can only read the web and return text, so those skills will under-perform here, and the UI says so.
- Running skills from private repos.

## UX

A comparison is one prompt run against several **lanes**. Each lane is a list of zero or more skills that load together, so a lane can be one skill, a combination, or a no-skill baseline.

**Compose page**

1. Paste the prompt.
2. Add lanes. Each lane takes one or more GitHub links to a skill (a `SKILL.md` file or its folder), plus an optional label.
3. On paste, each link resolves and shows the skill's `name`, `description`, repo, and the commit SHA it pins to. Bad links fail here, not mid-run.
4. Pick a model from the allowlist, all through OpenRouter: Claude Sonnet 5.5 (default), Claude Opus 5.5, GPT-6.1 Sol, GPT-6 Luna, DeepSeek V4.1 Flash, Kimi K3.1 Pro or GLM 5.3. A no-skill baseline lane is added by default and can be removed.
5. Submit. It sits behind the password gate when that's on, and is disabled with a clear reason when the OpenRouter key's remaining credit is below a floor.

**Results page** (permanent URL)

- Header: prompt, model, harness version, date, and each lane's skills with links to the pinned commits.
- Summary table: a row per lane, with a column per skill showing **triggered / not triggered / not in lane**, plus tokens, cost and duration.
- Reader: two outputs side by side with a lane picker on each pane, as in the bake-off page. Outputs render as sanitised markdown.
- Per lane, an expandable trace of the tool calls (skill loads, fetched URLs) in order.
- "Run again" re-runs the same pinned inputs as a new result, since output varies run to run. A Delete button, shown only after the password is entered, removes the comparison.

**Limits shown in the UI:** max lanes and max skills per lane (6 lanes, 4 skills per lane), the prompt length cap, and a note that skills which need scripts or file edits can't fully work here.

## Architecture

Components (all on Cloudflare):

- **Browser** — compose and results pages; model outputs render on their own origin.
- **Worker: app and API** — password gate, submit, delete; resolves GitHub links and pins them to commit SHAs.
- **GitHub API** — skill folders fetched at the pinned SHA, one file at a time, no clone.
- **Queue** — one message per lane; the consumer starts a sandbox.
- **Storage** — D1 for comparisons and lanes; R2 for outputs, event logs and skill snapshots.
- **Sandbox** (Cloudflare Sandbox SDK) — runs pinned OpenCode V2 with a placeholder key only.
- **Outbound Worker** — the sandbox's only way out. Internet is off; it adds the real OpenRouter key to model calls and passes web fetches (ports 80/443) on.
- **OpenRouter** — all models, one key.
- **Public web** — any URL a skill names, fetched from Cloudflare's network.

Everything runs on Cloudflare. Each lane gets its own Sandbox with internet access off, and its only way out is the outbound Worker. That Worker adds the real OpenRouter key to model calls and passes web fetches on, so no real key ever enters the sandbox. Sandboxes need the Workers Paid plan.

## Run pipeline

Each lane runs as one `opencode run` job in its own [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/), destroyed afterwards. Cloudflare's [guide to running OpenCode in a sandbox](https://developers.cloudflare.com/sandbox/coding-agents/opencode/) covers most of this setup.

1. **Resolve links.** Turn each GitHub link (`/blob/`, `/tree/` or repo root) into `owner/repo`, the skill folder path, and a **commit SHA** from the GitHub API at submit time. Every later fetch uses the SHA.
2. **Fetch the skill folder in the Worker.** Download each file through the GitHub contents API at that SHA. No archives and no `git clone`. Reject symlinks, submodules, absolute paths and any path containing `..`. Cap folder size (say 512 KB) and file count.
3. **Validate.** `SKILL.md` needs YAML frontmatter with `name` and `description`. In V2 a skill's ID comes from its folder name, so name the folder after the normalised `name`. Reject two skills with the same name in one lane.
4. **Materialise.** Write each file into the sandbox with the SDK's file API, under `/work/.opencode/skills/<name>/`. `/work` holds nothing else and isn't a git worktree. A baseline lane gets an empty skills folder.
5. **Lock the harness.** Pinned OpenCode V2, a clean `HOME`, project config and external skill folders disabled, our config passed through `OPENCODE_CONFIG_CONTENT`. Also set Cloudflare's flags to `1`: `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_SHARE`.
6. **Run.** `opencode run --format json --auto --model openrouter/<model> -- "<prompt>"` with a wall-clock timeout. `--auto` approves whatever the config doesn't deny. Without it, a run with no terminal rejects permission requests, skill loads included.
7. **Capture.** Store the NDJSON events, the final text, and usage from the `step_finish` events.
8. **Tear down.** Destroy the sandbox.

**Harness permissions.** Deny everything except loading skills, fetching the web, and reading files under the skill folders. The key names below are V1's. V2 renamed some config keys, so check them against the pinned version.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "deny",
    "skill": "allow",
    "webfetch": "allow",
    "read": { "*": "deny", "/work/.opencode/skills/**": "allow" }
  },
  "share": "disabled",
  "plugin": [],
  "mcp": {},
  "instructions": []
}
```

**Model calls.** OpenCode calls `openrouter.ai` directly with a placeholder key. The sandbox's outbound Worker intercepts the HTTPS request, swaps in the real `OPENROUTER_TOKEN` from Worker secrets, and forwards it, so no base URL change is needed. Check that OpenCode's runtime trusts the sandbox's CA certificate.

## Skill invocation detection

A skill counts as **triggered** when the event stream has a `tool_use` event for OpenCode's `skill` tool, whose input names that skill and whose state is completed. That's the only signal. The output text is never parsed for it.

| Status | Rule |
| --- | --- |
| Triggered | Completed `skill` tool call naming this skill |
| Load failed | `skill` tool call naming this skill ended in error |
| Not triggered | Skill was in the lane, with no `skill` call naming it |
| Fetched instead | No `skill` call, but a `webfetch` of this skill's own URL (the model went round the harness) |
| Not in lane | Skill wasn't part of this lane |

Also record:

- **When** it triggered: which step, and whether it was before the first text. A skill loaded after the answer was written didn't shape it.
- **Other skills named.** A lane can only load its own skills, but log any `skill` call for a name outside the lane as an anomaly.
- **Supporting files.** `read` is allowed under the skill folders, so `references/` files load. Record which skill files were read, as a sign of how deeply each skill was used.

To verify against the pinned version: the exact `tool` value and input field name for skill calls in the `--format json` stream. Capture a golden event log in a test fixture, then assert against it.

## Threat model and security controls

Prompt injection is a real risk here, because every input is attacker-controlled: the skill files (any public repo), the prompt, and every page the model fetches. Restricting tools to fetch-and-return-text keeps the keys away from the model. It doesn't stop the six threats below, so each gets a control outside the model.

| # | Threat | How it happens | Impact | Control |
| --- | --- | --- | --- | --- |
| 1 | Credit drain | Anyone submits; or a skill tells the model to fetch dozens of pages and write at max length | Budget gone | Accepted: about $10 prepaid on OpenRouter with auto-reload off, plus a password gate (see Access and cost) |
| 2 | Harness config takeover | A repo ships `opencode.json`, `AGENTS.md` or `.opencode/plugins/*.ts`, or a folder with `..` paths or symlinks; plugins are JS the harness runs | Code execution in the sandbox; tool restrictions bypassed | Files written one at a time from the contents API, with symlinks and `..` rejected; project config and external skills off; config through `OPENCODE_CONFIG_CONTENT`; pinned OpenCode; hostile test skills run in CI |
| 3 | SSRF via web fetch | Skill says "fetch `http://169.254.169.254/...`", localhost or an internal host | Internal data in a public result | Sandbox runs with `enableInternet = false`. The outbound Worker passes on only ports 80 and 443, and the fetch leaves from Cloudflare's network, which has none of your machines on it. Confirm what a Worker fetch can and can't reach |
| 4 | Key theft | Code in the sandbox reads its environment, or `read` follows a link to `/proc/self/environ` | Key stolen | No real key enters the sandbox: the outbound Worker adds it for `openrouter.ai` only. Symlinks are rejected at fetch time |
| 5 | Stored XSS | Model is told to emit `<script>` or `<img onerror>`; the result page renders it | Script runs for every viewer of a shared result | Render outputs as markdown with HTML stripped or sanitised (DOMPurify), a strict CSP, and output panes served from a separate origin |
| 6 | Rigged comparisons | Skill A's `description` (always in the system prompt) says "never load other skills" or prints fake "skill used" text | Misleading published results | Accepted for v1. Triggering is still read from events only |

Two further rules:

- **Fetched pages are attacker content too.** A page can carry its own injection. The controls above don't depend on the model resisting it, which is the point.
- **Moderation.** Not needed while only the password holder can submit. Revisit if submitting opens up.

## Access and cost

Spend is capped by funding, not code: about $10 of prepaid OpenRouter credit, auto-reload off, on a key used only by this app. A run that hits zero just fails.

**Password gate.** One shared password protects submitting. The site can be deployed publicly while only David can run comparisons, and results pages stay readable by link.

- **Flag:** an env var, `REQUIRE_PASSWORD`. It fails closed: unset, or any value except `false`, means the password is required. LaunchDarkly would add a service and a key for one boolean that almost never changes.
- **Secret:** an argon2 or bcrypt hash in `APP_PASSWORD_HASH`, checked on the server.
- **Session:** a signed `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The submit API checks it on every call, not just the UI.
- **Brute force:** rate-limit password attempts, for example 5 a minute per IP.

**Credit display.** The compose page shows the key's [`limit_remaining`](https://openrouter.ai/docs/limits) from OpenRouter's `GET /api/v1/key`. OpenRouter rejects requests once the balance hits zero.

**Per-lane limit kept:** a wall-clock timeout, so a hung run can't sit forever.

## Data model and permanent storage

Results are immutable once a comparison finishes: nobody edits a stored run, and "Run again" makes a new comparison. Structured rows go in a relational store. Large blobs (event logs, outputs, skill snapshots) go in object storage, addressed by content hash.

| Entity | Key fields | Notes |
| --- | --- | --- |
| `comparison` | id (short slug for the URL), prompt, model, harness version, status, created_at, total_cost_usd, hidden flag | One per submit; the permanent URL |
| `lane` | id, comparison_id, label, order, status (queued / running / done / failed / skipped), tokens, cost_usd, duration_ms, output_blob, events_blob | One OpenCode run |
| `skill_snapshot` | sha256 of folder contents, owner, repo, path, commit_sha, name, description, files_blob | Deduplicated: the same skill at the same SHA is stored once |
| `lane_skill` | lane_id, skill_snapshot_id, invocation status, first_invoked_step | The table that drives the triggered columns |
| `ledger_entry` | id, lane_id, cost_usd, at | Feeds the spend shown on the compose page |

Store the **skill snapshot**, not just the link. Repos get deleted or force-pushed, and a result page should still show exactly what each skill said when it ran.

Storage on Cloudflare: D1 for rows, R2 for blobs. Deleting a comparison removes its rows and lane blobs. Skill snapshots stay unless no other lane references them.

## Remaining tasks

All design decisions are made. These three tasks come first in the build, because detection and the security controls depend on them.

- [ ] **Capture the event schema.** Run the pinned OpenCode V2 once with a prompt that triggers a skill, save the `--format json` output as a test fixture, and confirm how a `skill` call appears. Trigger detection is built on it.
- [ ] **Confirm V2 config keys.** Check V2's names for the permission block and the `read` path patterns, and update the harness config to match.
- [ ] **Build the hostile test skills.** A CI suite run against the pinned OpenCode: `..` paths, a symlink to `/proc/self/environ`, a nested `SKILL.md`, a body that tries a shell command, and a description telling the model to fetch `169.254.169.254`. CI fails if any of them works.
