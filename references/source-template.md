# Source Template Layout

The scaffold script pulls a whitelisted set of files from a public template
repository and rewrites user-specific placeholders. The skill is fully
self-contained — the user's agent does **not** need a local copy of the template.

## Default source

A GitHub repository containing the meta-project source (allowlisted files only,
no user data). Two ways to point at it:

1. **Default** — `oliver0518/ai-video-workspace` (public). This is a self-hosted
   repo that carries **both** the skill (`SKILL.md` / `scripts/` / `references/`
   / `docs/`) **and** the allowlisted meta-project files at the repo root. The
   script runs `gh repo clone oliver0518/ai-video-workspace <scratch> -- --depth 1`,
   uses the clone as the source, applies the denylist to strip the skill-side
   files (`SKILL.md / scripts/ / references/ / docs/`), copies only the
   meta-project files into the new workspace, and wipes the scratch dir on
   exit. No local checkout is required.
2. **Override** — pass `--source <dir>` to the script (or `--template-repo
   <owner/name>` to point at a fork of the public template). Useful for testing
   local changes before publishing them upstream.

The repo is intentionally a thin mirror of the meta-project: same code, no
`.env` / `jobs.json` / `projects.json` / `outputs/`. User data never leaves the
local machine it belongs to.

## Files copied verbatim

```
app.py                      # Flask server + Agnes client + queue
启动工作台.command            # macOS launcher
需求文档.md                  # product spec, kept as-is for reference
.gitignore                  # updated by the script with denylist entries
.env.example                # the scaffold script writes .env from this
static/                     # whole dir: app.js, canvas.js, index.html, style.css
```

## Files explicitly skipped (user data)

```
.env            # contains previous user's API key — script writes a fresh one
jobs.json       # generation queue, may contain active jobs
projects.json   # IndexedDB cache mirror
outputs/        # downloaded videos
__pycache__/    # python bytecode
build/          # pyinstaller output
.DS_Store       # macOS
*.pyc
node_modules/
.venv/
```

The script enforces both an allowlist and a denylist; unknown top-level files are
skipped with a warning rather than copied silently.

## Substitution rules

Inside the **allowlisted text files** (excluding `app.py` and `.env`, which have
their own config paths), the script rewrites the following placeholders:

| Placeholder        | Replacement            | Where it appears          |
|--------------------|------------------------|----------------------------|
| `<nickname>`       | user's slug            | docs, launcher title      |
| `{{nickname}}`     | user's slug            | docs                      |
| `AGNES_API_KEY=*`  | the user's API key     | `.env` only                |
| `WORKBENCH_NICK=*` | the user's slug        | `.env` only                |

If a file outside the allowlist needs the placeholder substituted, add it to
`ALLOWED_FILES` in `scripts/scaffold.sh` and re-publish both this skill and the
template repo.

## How to keep the template in sync with the meta-project

When the meta-project gains a new top-level file the user wants in every fresh
workspace (e.g. a new config file, a new static asset dir), do all three:

1. Add the file/dir to `ALLOWED_FILES` in `scripts/scaffold.sh`.
2. Add it to "Files copied verbatim" above.
3. Push the new file to `oliver0518/ai-video-workspace` (and the meta-project
   itself, if it has a public home).

Re-run the skill's eval round to confirm the new file lands in fresh repos.

## Forking / self-hosting

If you fork the repo under your own GitHub account, override at scaffold
time:

```bash
scaffold.sh --nickname me --api-key sk-... \
            --template-repo <you>/ai-video-workspace \
            --dest ~/Desktop/me-video-workbench
```

This is the path for users who want to ship their own branded workbench, or for
organizations that need a private one.
