#!/usr/bin/env bash
# Agnes Video Workbench scaffold.
# Copies a whitelisted template directory into a fresh workspace, swaps in
# the user's API key + nickname, and pushes to GitHub via `gh repo create`.
#
# Designed to be called by the agnes-video-workbench skill — do not run by
# hand without reading SKILL.md first. The skill collects the api-key and
# nickname from the user before invoking this script.
#
# Default source = the public GitHub repo that hosts both the skill and
# the meta-project template (oliver0518/ai-video-workspace). The skill clones
# itself and copies only the allowlisted meta-project files. Override with
# --template-repo <owner/name> for fork-based setups.

set -euo pipefail

# ---- args ------------------------------------------------------------------
NICKNAME=""
API_KEY=""
SOURCE=""
DEST=""
VISIBILITY="private"
TEMPLATE_REPO="oliver0518/ai-video-workspace"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nickname)      NICKNAME="$2"; shift 2 ;;
    --api-key)       API_KEY="$2"; shift 2 ;;
    --source)        SOURCE="$2"; shift 2 ;;
    --dest)          DEST="$2"; shift 2 ;;
    --visibility)    VISIBILITY="$2"; shift 2 ;;
    --template-repo) TEMPLATE_REPO="$2"; shift 2 ;;
    -h|--help)
      cat <<USAGE
Usage: scaffold.sh --nickname <slug> --api-key <sk-...>
                   --dest <workspace-dir>
                   [--source <template-dir>]
                   [--template-repo <owner/name>]
                   [--visibility public|private]

If --source is not given, the script clones oliver0518/ai-video-workspace
from GitHub into a temp dir and uses that as the template. The same repo
hosts the skill itself; the denylist below strips SKILL.md / docs / scripts /
references so the new workspace only gets the meta-project files.
USAGE
      exit 0 ;;
    *)
      echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- validate --------------------------------------------------------------
if [[ -z "$NICKNAME" || -z "$API_KEY" || -z "$DEST" ]]; then
  echo "missing required arg (--nickname / --api-key / --dest)" >&2
  exit 2
fi
if ! [[ "$NICKNAME" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]]; then
  echo "nickname must match ^[a-z0-9][a-z0-9-]{1,30}\$ — got: $NICKNAME" >&2
  exit 2
fi
if ! [[ "$API_KEY" =~ ^sk-[A-Za-z0-9]+$ ]]; then
  echo "api-key must look like sk-XXXX — got: ${API_KEY:0:4}..." >&2
  exit 2
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not installed — run: brew install gh" >&2
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh not logged in — run: gh auth login" >&2
  exit 2
fi
if [[ "$VISIBILITY" != "public" && "$VISIBILITY" != "private" ]]; then
  echo "visibility must be public or private — got: $VISIBILITY" >&2
  exit 2
fi
if [[ -e "$DEST" ]]; then
  echo "dest already exists (refusing to overwrite): $DEST" >&2
  exit 2
fi

# ---- 0. resolve template source ---------------------------------------------
# If the user didn't pass --source, clone the public template repo into a
# scratch dir and use that. This makes the skill self-contained — no local
# template path required.
SOURCE_MODE="local"
SOURCE_CLEANUP=""
if [[ -z "$SOURCE" ]]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "git not installed — required to fetch the default template" >&2
    exit 2
  fi
  SCRATCH="${TMPDIR:-/tmp}/agnes-scaffold-$$-$RANDOM"
  echo "==> cloning template repo: $TEMPLATE_REPO -> $SCRATCH"
  if ! gh repo clone "$TEMPLATE_REPO" "$SCRATCH" -- --depth 1 >/dev/null 2>&1; then
    echo "failed to clone $TEMPLATE_REPO — check repo exists and you have access" >&2
    exit 2
  fi
  SOURCE="$SCRATCH"
  SOURCE_MODE="remote"
  SOURCE_CLEANUP="$SCRATCH"
  trap 'rm -rf "$SOURCE_CLEANUP" 2>/dev/null || true' EXIT
fi
if [[ ! -d "$SOURCE" ]]; then
  echo "source template not found: $SOURCE" >&2
  exit 2
fi

# ---- 1. copy whitelist, skip user-data --------------------------------------
REPO_NAME="agnes-video-workbench-$NICKNAME"

mkdir -p "$DEST"
echo "==> copying template files from $SOURCE to $DEST"

# Allowlist of files / dirs to copy. Everything else is treated as user-data
# (api keys, jobs queue, cached builds, macOS metadata).
ALLOWED_FILES=(
  app.py
  启动工作台.command
  需求文档.md
  .gitignore
  .env.example
  static
)
# Explicit denylist, in case the allowlist ever misses a file the source has.
# Skill-side files (SKILL.md, scripts/, references/, docs/) are also denied so
# cloning the self-hosting ai-video-workspace repo doesn't drag the skill
# itself into the new workspace.
DENIED_PATTERNS=(
  ".env"          # real env file (contains previous user's API key)
  "jobs.json"     # queued jobs
  "projects.json" # IndexedDB cache
  "outputs"       # generated videos
  "__pycache__"   # python bytecode
  "build"         # pyinstaller output
  ".DS_Store"     # macOS metadata
  "*.pyc"
  "*.part"
  "node_modules"
  ".venv"
  "static/images" # user-generated AI images; each workspace gets its own
  "SKILL.md"      # skill-side: not part of the workbench
  "docs"          # skill-side: public landing page
  "scripts"       # skill-side: the scaffold script itself
  "references"    # skill-side: docs for the skill author
)

copy_allowed() {
  local entry
  for entry in "${ALLOWED_FILES[@]}"; do
    if [[ -e "$SOURCE/$entry" ]]; then
      cp -R "$SOURCE/$entry" "$DEST/"
    fi
  done
}

is_denied() {
  local name="$1"
  local pat
  for pat in "${DENIED_PATTERNS[@]}"; do
    # shell glob match (no regex chars except *)
    # shellcheck disable=SC2053
    if [[ "$name" == $pat ]]; then
      return 0
    fi
  done
  return 1
}

# Walk the source dir top-level. If a top-level entry is in the allowlist,
# copy it whole; if it matches a denylist, skip; otherwise refuse (don't silently
# drag unknown files into the new repo).
for entry in "$SOURCE"/* "$SOURCE"/.[!.]*; do
  [[ -e "$entry" ]] || continue
  base="$(basename "$entry")"
  if is_denied "$base"; then
    echo "    skip (denied): $base"
    continue
  fi
  found=0
  for allowed in "${ALLOWED_FILES[@]}"; do
    if [[ "$base" == "$allowed" ]]; then
      found=1; break
    fi
  done
  if [[ $found -eq 1 ]]; then
    cp -R "$entry" "$DEST/"
  else
    echo "    skip (not in allowlist): $base"
  fi
done

# ---- 2. write .env -----------------------------------------------------------
ENV_FILE="$DEST/.env"
ENV_EXAMPLE="$DEST/.env.example"
if [[ ! -f "$ENV_EXAMPLE" ]]; then
  echo ".env.example not found in template — refusing to write .env blind" >&2
  exit 2
fi
# Start from .env.example, then replace key + nickname lines. Keep all other
# placeholders the template ships with.
cp "$ENV_EXAMPLE" "$ENV_FILE"
# Use a python one-liner to do safe env writes (avoids sed quoting hell).
python3 - "$ENV_FILE" "$API_KEY" "$NICKNAME" <<'PY'
import sys, pathlib
path, key, nick = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(path).read_text()
lines = []
seen_key = seen_nick = False
for line in text.splitlines():
    if line.startswith("AGNES_API_KEY="):
        lines.append(f"AGNES_API_KEY={key}")
        seen_key = True
    elif line.startswith("WORKBENCH_NICK="):
        lines.append(f"WORKBENCH_NICK={nick}")
        seen_nick = True
    else:
        lines.append(line)
if not seen_key:
    lines.append(f"AGNES_API_KEY={key}")
if not seen_nick:
    lines.append(f"WORKBENCH_NICK={nick}")
pathlib.Path(path).write_text("\n".join(lines) + "\n")
PY
chmod 600 "$ENV_FILE"   # api key is sensitive
echo "==> wrote .env with key=${API_KEY:0:6}... nick=$NICKNAME"

# ---- 3. replace nickname placeholders in template text --------------------
# Any literal `<nickname>` / {{nickname}} / 占位 placeholder inside the copied
# files is rewritten. macOS sed needs '' after -i; Linux uses -i with no arg.
SED_INPLACE=(-i)
if sed --version >/dev/null 2>&1; then  # GNU sed (Linux)
  SED_INPLACE=(-i)
else                                        # BSD sed (macOS)
  SED_INPLACE=(-i "")
fi
# We deliberately do NOT rewrite app.py or .env (those have their own config
# mechanisms). Only rewrite human-readable docs / titles.
for f in "$DEST/需求文档.md" "$DEST/启动工作台.command"; do
  if [[ -f "$f" ]]; then
    sed "${SED_INPLACE[@]}" "s/<nickname>/$NICKNAME/g; s/{{nickname}}/$NICKNAME/g" "$f"
  fi
done
echo "==> replaced <nickname> placeholders in template docs"

# ---- 4. git init + commit ---------------------------------------------------
cd "$DEST"
# Verify .gitignore excludes the user-data patterns (denylist).
GITIGNORE="$DEST/.gitignore"
touch "$GITIGNORE"
for pat in "${DENIED_PATTERNS[@]}"; do
  if ! grep -qxF "$pat" "$GITIGNORE"; then
    echo "$pat" >> "$GITIGNORE"
  fi
done

git init -q -b main
git config user.name >/dev/null 2>&1 || git config user.name "$(gh api user --jq .login 2>/dev/null || echo agnes-scaffold)"
git config user.email >/dev/null 2>&1 || git config user.email "scaffold@agnes.local"
git add .
git commit -q -m "chore: initial scaffold for $REPO_NAME"
echo "==> initial commit created"

# ---- 5. gh repo create + push ----------------------------------------------
# Handle name collision by appending -2, -3, ...
attempt="$REPO_NAME"
for i in 2 3 4 5 6 7 8 9; do
  if gh repo view "$attempt" >/dev/null 2>&1; then
    attempt="${REPO_NAME}-${i}"
  else
    break
  fi
done
if gh repo view "$attempt" >/dev/null 2>&1; then
  echo "could not find an unused repo name after 9 attempts — giving up" >&2
  exit 2
fi

echo "==> creating GitHub repo: $attempt ($VISIBILITY)"
gh repo create "$attempt" \
  --source=. \
  --push \
  --"$VISIBILITY" \
  --description "Agnes AI video workbench for $NICKNAME" \
  --homepage "https://github.com/$attempt" \
  || { echo "gh repo create failed" >&2; exit 2; }

OWNER="$(gh repo view --json owner -q .owner.login "$attempt")"
REPO_URL="https://github.com/$OWNER/$attempt"

# Final report (consumed by the skill — keep stable format).
cat <<REPORT
workspace_ready
local=$DEST
repo=$REPO_URL
repo_name=$attempt
visibility=$VISIBILITY
start_cmd=cd "$DEST" && bash 启动工作台.command
key_tail=${API_KEY: -4}
REPORT
