# agnes-video-workbench

MiniMax Code skill that scaffolds a fresh **Agnes AI video workbench** for a user
from their API key + nickname.

When a user says *"帮我搭一个 agnes 工作台，nickname 用 `xxx`"*, the model loads this
skill, asks for the two missing values, then runs a single deterministic script
that copies the meta-project template and writes a clean `.env` to
`~/Desktop/<nickname>-workspace`.

By default the scaffold is **local-only** — no GitHub repo is created, no `gh`
authentication is required, and no remote is configured. Pass `--push` to the
script (or ask the user before running it) to also create a private GitHub repo
and push.

## Quick start (as a skill consumer)

1. Trigger the skill with one of the natural-language prompts listed in
   [`SKILL.md`](./SKILL.md) (frontmatter `description`).
2. The skill will ask for:
   - **Agnes API key** — must match `^sk-[A-Za-z0-9]+$`
   - **Nickname** — slug matching `^[a-z0-9][a-z0-9-]{1,30}$`
   - **Push to GitHub?** — defaults to no. Say "推到 GitHub" / "publish" to opt in.
3. The skill reports back: local path, optional repo URL, start command, masked key.

`gh` is only required if you opted into `--push`. For a local-only scaffold you
don't need a GitHub account, a network connection (beyond the initial template
clone), or even `gh` installed.

## Files

```
SKILL.md                       procedure + onboarding contract
scripts/scaffold.sh            deterministic workhorse (bash, no npm deps)
references/source-template.md  allowlist/denylist contract for the template
```

## What the script does

For each run, given `--nickname`, `--api-key`, and (optionally) `--dest`,
`--push`, `--source`, `--template-repo`, `--visibility`:

1. **Copies** an allowlist of template files (`app.py`, `static/`, `.env.example`,
   `启动工作台.command`, `需求文档.md`, `.gitignore`). Explicitly **skips** user-data
   files (`.env` real, `jobs.json`, `projects.json`, `outputs/`, `__pycache__/`,
   `build/`, `.DS_Store`) and skill-side files (`SKILL.md`, `scripts/`,
   `references/`, `docs/`) so the skill never ships into a scaffolded workbench.
2. **Writes** a fresh `.env` from `.env.example` with the user's key + nickname,
   then `chmod 600`.
3. **Replaces** `<nickname>` / `{{nickname}}` placeholders inside allowlisted
   text files (skips `app.py` and `.env`, which have their own config paths).
4. **Initialises git** in the new workspace, ensures the denylist is in
   `.gitignore`, commits.
5. **Only with `--push`**: `gh repo create <nickname>-workspace --source=. --push
   --<visibility>`. Auto-appends `-2..-9` if the name is taken.

If `--dest` is not given, the script writes to `~/Desktop/<nickname>-workspace`.

## Updating the template

When the source meta-project gains a new top-level file the user wants in every
fresh workspace, update both:

1. `scripts/scaffold.sh` — add the file/dir to `ALLOWED_FILES`.
2. `references/source-template.md` — add it to "Files copied verbatim".
3. Bump the skill on GitHub.

## Source template

Default: `oliver0518/ai-video-workspace` on GitHub. This single repo carries
both the skill (`SKILL.md` / `scripts/` / `references/` / `docs/`) and the
allowlisted meta-project files at the repo root — the denylist in
`scaffold.sh` strips the skill-side files before copying into a new workspace.
Override with `--template-repo <owner/name>` if you fork it.

## License

This skill is provided as-is for personal use; the workspaces it scaffolds
inherit the licensing of the source meta-project.
