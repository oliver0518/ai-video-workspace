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

- **Destination parent dir** — defaults to `~/Desktop`. Skip if the user just said
  "桌面".
- **Repo visibility** — defaults to `private`. Ask only if the user mentioned "公开" /
  "public" / "开源".

Never ask for: GitHub owner (use `gh` CLI's logged-in account), git author (use
`gh`'s default), or platform details (the script detects macOS vs Linux).

## Procedure

1. **Verify environment** before collecting inputs:
   - `command -v gh` returns a path; `gh auth status` reports a logged-in user.
     If not, stop and tell the user to run `gh auth login` first.
   - `command -v git` is available (needed only when fetching the remote template).
   - The user can write to the chosen destination parent dir (default `~/Desktop`).

2. **Collect inputs** — use the AskUserQuestion tool (or equivalent `ask_user`) with one
   question that has two text inputs (api key + nickname). Mention the slug format
   rule in the question.

3. **Run the scaffold** — `bash scripts/scaffold.sh --nickname <slug> --api-key <sk>
   --dest <dest-dir> [--source <template-dir>] [--visibility <public|private>]`. The script
   is deterministic and does five things in order:

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
      <slug>-video-workbench"`. The `.gitignore` from the template excludes the
      user-data files copied in step 1 (verify before commit).
   5. `gh repo create agnes-video-workbench-<slug> --source=<dest> --push
      --<visibility> --description "Agnes AI video workbench for <slug>"`. Capture
      the repo URL from stdout.

4. **Report** the result to the user:
   - The new local path (`~/Desktop/<slug>-video-workbench`)
   - The new GitHub URL (from `gh repo create` output)
   - The first-run command (`cd ~/Desktop/<slug>-video-workbench && bash 启动工作台.command`)

## Output contract

A single success message with four lines:

```
Workspace ready:
  local: /Users/<you>/Desktop/<slug>-video-workbench
  repo:  https://github.com/<owner>/agnes-video-workbench-<slug>
  start: cd /Users/<you>/Desktop/<slug>-video-workbench && bash 启动工作台.command
  env:   AGNES_API_KEY=<last 4 chars>...  WORKBENCH_NICK=<slug>
```

If any step fails (template missing, `gh` not authed, git push rejected), report the
specific failing step and the original stderr. Do NOT attempt partial recovery —
partial scaffolds confuse the user more than a clean failure.

## Failure handling

- **API key shape wrong** — refuse early. Do not proceed with an obviously broken
  key, because the resulting repo would fail on first request.
- **`gh` not logged in** — stop and tell the user to run `gh auth login` (or
  `gh auth login --with-token`). The script will not retry auth.
- **Repo name already taken on GitHub** — append a numeric suffix (`-2`, `-3`,
  ...) up to `-9`, then give up with a clear error. Do not silently overwrite.
- **Disk full / permission denied** — print the path the script was trying to
  write to and stop. Do not retry with a different path.
- **`git push` rejected** (e.g. token expired) — print the `gh` stderr verbatim.
  Do not attempt to fix credentials on the user's behalf.

## Examples

**Single happy-path turn**:

> User: "帮我搭一个 agnes 工作台，nickname 用 `xiaowang`"
>
> LLM: asks for API key, gets `sk-3fIBPxS3PuBisDq6Lm0jPIViAiRkZpJCxQdwNPKVXbbrgpxu`.
> Runs `bash scripts/scaffold.sh --nickname xiaowang --api-key sk-... --source
> <template> --dest ~/Desktop/xiaowang-video-workbench --visibility private`.
> Reports local path, repo URL, start command, masked key.

**Recoverable error turn**:

> User: "把工作台抽成 skill"
>
> LLM: asks for nickname + key. While running `gh auth status` reports "not logged
> in", LLM stops and tells the user: "需要先 `gh auth login`，否则无法推送。重新发起
> 后我会从你中断的地方继续。" (The scaffold script is idempotent — re-running
> after auth works the same way.)
