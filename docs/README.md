# agnes-video-workbench

MiniMax Code skill that scaffolds a fresh **Agnes AI video workbench** for a user from
their API key + nickname, and pushes the new workspace to GitHub.

When a user says *"帮我搭一个 agnes 工作台，nickname 用 `xxx`"*, the model loads this
skill, asks for the two missing values, then runs a single deterministic script that
copies the meta-project template, writes a clean `.env`, and pushes the new repo via
`gh repo create`.

## Quick start (as a skill consumer)

1. Make sure `gh auth status` reports a logged-in user — this skill will not work
   without it.
2. Trigger the skill with one of the natural-language prompts listed in
   [`SKILL.md`](./SKILL.md) (frontmatter `description`).
3. The skill will ask for:
   - **Agnes API key** — must match `^sk-[A-Za-z0-9]+$`
   - **Nickname** — slug matching `^[a-z0-9][a-z0-9-]{1,30}$`
4. The skill reports back: local path, repo URL, start command, masked key.

## Files

```
SKILL.md                       procedure + onboarding contract
scripts/scaffold.sh            deterministic workhorse (bash, no npm deps)
references/source-template.md  allowlist/denylist contract for the template
```

## What the script does

For each run, given `--nickname`, `--api-key`, `--source <meta-project>`, and
`--dest <workspace>`:

1. **Copies** an allowlist of template files (`app.py`, `static/`, `.env.example`,
   `启动工作台.command`, `需求文档.md`, `.gitignore`). Explicitly **skips** user-data
   files (`.env` real, `jobs.json`, `projects.json`, `outputs/`, `__pycache__/`,
   `build/`, `.DS_Store`).
2. **Writes** a fresh `.env` from `.env.example` with the user's key + nickname, then
   `chmod 600`.
3. **Replaces** `<nickname>` / `{{nickname}}` placeholders inside allowlisted
   text files (skips `app.py` and `.env`, which have their own config paths).
4. **Initialises git** in the new workspace, ensures the denylist is in
   `.gitignore`, commits.
5. **Pushes** via `gh repo create agnes-video-workbench-<slug> --source=. --push
   --<visibility>`. Auto-appends `-2..-9` if the name is taken.

## Updating the template

When the source meta-project gains a new top-level file the user wants in every
fresh workspace, update both:

1. `scripts/scaffold.sh` — add the file/dir to `ALLOWED_FILES`.
2. `references/source-template.md` — add it to "Files copied verbatim".
3. Bump the skill on GitHub.

## Source template

Default: `/Users/Oliver/Desktop/秋白视频工作台` (the meta-project that produced
this skill). Override with `--source <dir>` if the template lives elsewhere.

## License

This skill is provided as-is for personal use; the workspaces it scaffolds inherit
the licensing of the source meta-project.
