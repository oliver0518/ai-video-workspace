---
name: agnes-video-workbench
description: |
  Scaffold a per-user Agnes AI video workbench on macOS/Linux. Use when the user says
  "scaffold agnes workbench", "create a video workbench for me", "set up agnes for
  <nickname>", "把工作台抽成skill", or asks to provision a fresh workspace tied to
  their own Agnes API key. Do NOT use for general project editing, image/video
  generation calls, or cloning an existing repo.
---

# Agnes Video Workbench Scaffold

## What this skill produces

A single new project directory on the user's machine, named
**`~/Desktop/<nickname>-workspace`** (where `<nickname>` is the slug the user
provides). The directory contains a working copy of the meta-project with
the user's API key wired in, ready to launch with `bash 启动工作台.command`.

By default the scaffold is **local-only** — no GitHub repo is created, no
remote is configured, and no `gh` authentication is required. Pass
`--push` to the script (or ask the user before running it) to also create
a private GitHub repo and push.

## Inputs to collect

The skill is fully driven by two values from the user. Ask for them up front, in one
breath — never infer from env vars, never read `~/.zshrc`, never guess a nickname.

1. **Agnes API key** — string starting with `sk-`. Validate it matches `/^sk-[A-Za-z0-9]+$/`
   before proceeding. If the user pastes it with surrounding whitespace or quotes,
   strip them first.
2. **Nickname** — short slug, `[a-z0-9][a-z0-9-]{1,30}`. Used for the workspace folder
   name, repo name, and `.env` `WORKBENCH_NICK` variable. If the user gives a longer
   Chinese name, ask them to translate to a slug (or pick one yourself and confirm).

Optional, with sensible defaults — confirm rather than re-ask:

- **Destination parent dir** — defaults to `~/Desktop`. The actual directory
  will be `~/Desktop/<nickname>-workspace`. Skip if the user just said "桌面".
- **Push to GitHub?** — defaults to **no**. The skill produces a local-only
  workspace unless the user explicitly says "推到 GitHub" / "push" / "publish".
  If they do, pass `--push` to the script and ask about visibility (defaults
  to `private`).

Never ask for: GitHub owner (use `gh` CLI's logged-in account, only when `--push`),
git author (the script picks a sane default), or platform details (the script
detects macOS vs Linux).

## Procedure

1. **Verify environment** before collecting inputs:
   - `command -v git` is available (needed only when fetching the remote template).
   - `command -v gh` returns a path AND `gh auth status` reports a logged-in user
     **only if the user asked to push**. For a local-only scaffold, neither is
     required.
   - The user can write to `~/Desktop` (or the chosen destination parent dir).

2. **Collect inputs** — use the AskUserQuestion tool (or equivalent `ask_user`) with one
   question that has two text inputs (api key + nickname). Mention the slug format
   rule in the question. Also confirm whether to push to GitHub.

3. **Run the scaffold** — `bash scripts/scaffold.sh --nickname <slug> --api-key <sk>
   [--dest <dir>] [--push]`. The script is deterministic and does up to five things:

   0. **Fetch the template** if `--source` was not given. Default = `gh repo clone
      oliver0518/ai-video-workspace` into a scratch dir (cloned with `--depth 1`).
      The skill is self-hosted: this same repo carries `SKILL.md / scripts/ /
      references / docs/` (the skill itself) plus the allowlisted meta-project
      files at the repo root. The denylist in `scripts/scaffold.sh` strips the
      skill-side files before copying into the user's new workspace, so the skill
      never ships into a scaffolded workbench.
      The scratch dir is wiped on exit. Reason: this keeps the skill self-contained —
      users do not need a local copy of the template on disk.
   1. Copy the whitelist of template files (see `references/source-template.md`) from
      `<source>` to `<dest>/`, skipping user-data files (`.env` real, `jobs.json`,
      `projects.json`, `outputs/`, `__pycache__/`, `build/`, `.DS_Store`).
      Reason: the template might still carry the previous user's API key, jobs, and
      cached build artifacts — copying them would leak the previous user and bloat the
      new repo.
   2. Write `<dest>/.env` from `.env.example`, substituting `AGNES_API_KEY=<key>` and
      `WORKBENCH_NICK=<slug>`. The script refuses to leave the previous user's
      `.env` intact.
   3. Replace `<nickname>` placeholders inside the template files (e.g. any default
      title, README) using a single `sed -i ''` pass with the slug.
   4. `git init`, `git add .`, `git commit -m "chore: initial scaffold for
      <nickname>-workspace"`. The `.gitignore` from the template excludes the
      user-data files copied in step 1 (verify before commit).
   5. **Only with `--push`**: `gh repo create <nickname>-workspace --source=<dest>
      --push --<visibility> --description "Agnes AI video workbench for <slug>"`.
      Without `--push`, this step is skipped — the workbench is local-only and the
      commit lives only on disk.

4. **Report** the result to the user:
   - The new local path (`~/Desktop/<slug>-workspace`)
   - If pushed: the new GitHub URL (from `gh repo create` output). Otherwise: "no
     GitHub repo created (local-only)".
   - The first-run command (`cd ~/Desktop/<slug>-workspace && bash 启动工作台.command`)

## Output contract

A single success message with four lines:

```
Workspace ready:
  local: /Users/<you>/Desktop/<slug>-workspace
  repo:  <github-url-if-pushed, otherwise "(local-only)">
  start: cd /Users/<you>/Desktop/<slug>-workspace && bash 启动工作台.command
  env:   AGNES_API_KEY=<last 4 chars>...  WORKBENCH_NICK=<slug>
```

If any step fails (template missing, `gh` not authed when `--push` is set, git
push rejected), report the specific failing step and the original stderr. Do
NOT attempt partial recovery — partial scaffolds confuse the user more than a
clean failure.

## Failure handling

- **API key shape wrong** — refuse early. Do not proceed with an obviously broken
  key, because the resulting repo would fail on first request.
- **`gh` not logged in (only matters with `--push`)** — stop and tell the user to
  run `gh auth login` (or `gh auth login --with-token`). The script will not retry
  auth.
- **Repo name already taken on GitHub (only matters with `--push`)** — append a
  numeric suffix (`-2`, `-3`, ...) up to `-9`, then give up with a clear error.
  Do not silently overwrite.
- **Disk full / permission denied** — print the path the script was trying to
  write to and stop. Do not retry with a different path.
- **`git push` rejected (e.g. token expired)** — print the `gh` stderr verbatim.
  Do not attempt to fix credentials on the user's behalf.

## Examples

**Local-only happy-path turn** (most common):

> User: "帮我搭一个 agnes 工作台，nickname 用 `xiaowang`"
>
> LLM: asks for API key, gets `sk-3fIBPxS3PuBisDq6Lm0jPIViAiRkZpJCxQdwNPKVXbbrgpxu`.
> Confirms no push is wanted. Runs `bash scripts/scaffold.sh --nickname xiaowang
> --api-key sk-...`. Reports local path and start command, notes that no GitHub
> repo was created.

**Push-to-GitHub turn**:

> User: "搭个工作台，nickname 用 `xiaowang`，推到 GitHub 私有"
>
> LLM: asks for API key, gets `sk-...`. Runs `bash scripts/scaffold.sh
> --nickname xiaowang --api-key sk-... --push --visibility private`. Reports
> local path, repo URL, start command, masked key.

**Recoverable error turn**:

> User: "把工作台抽成 skill"
>
> LLM: asks for nickname + key. While running `gh auth status` reports "not
> logged in", LLM stops and tells the user: "需要先 `gh auth login`，否则
> 无法推送。重新发起后我会从你中断的地方继续。" (The scaffold script is
> idempotent — re-running after auth works the same way.)
