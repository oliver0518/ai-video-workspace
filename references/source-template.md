# Source Template Layout

The scaffold script copies from a fixed source directory (the reference implementation
of an Agnes video workbench) into a fresh workspace. The skill's `SKILL.md` procedure
assumes this layout; if the source moves, update this file and re-publish.

## Expected source location

Default: `/Users/Oliver/Desktop/秋白视频工作台` (the meta-project that produced this
skill). Override with `--source <dir>` if the user keeps the template elsewhere.

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
`ALLOWED_FILES` in `scripts/scaffold.sh` and re-publish.

## How to keep this skill up to date

When the meta-project gains a new top-level file the user wants in every fresh
workspace (e.g. a new config file, a new static asset dir), update both:

1. `scripts/scaffold.sh` — add the file/dir to `ALLOWED_FILES`.
2. This file — add it to "Files copied verbatim".
3. Re-run the skill's eval round to confirm the new file lands in fresh repos.
