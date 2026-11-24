#!/bin/sh
# One-touch installer for Johnny Neuromorphic (macOS, Apple Silicon).
#
#   ./install.sh          ask once, then do everything
#   ./install.sh --yes    no questions
#   ./install.sh --check  only check prerequisites, change nothing
#
# What it does: npm install, build, put `johnny` on your PATH (npm link), then run
# `johnny setup --yes` (Ollama via Homebrew if missing, the two local models, Claude Code
# hooks and MCP server, ingest of your existing sessions, automatic synthesis every 3 hours)
# and start the background daemon. `johnny uninstall` reverses the Claude Code wiring.
set -eu

YES=0; CHECK=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'x %s\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")"

[ "$(uname -s)" = "Darwin" ] || fail "Johnny supports macOS only."
[ "$(uname -m)" = "arm64" ] || say "! Apple Silicon is what Johnny is tested on; ($(uname -m)) is untested."

command -v node >/dev/null 2>&1 || fail "Node.js 20 is required. Install it (brew install node@20) and re-run."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required (found $(node -v))."
command -v npm >/dev/null 2>&1 || fail "npm not found."
if command -v claude >/dev/null 2>&1; then say "ok claude CLI found"; else say "! claude CLI not found: install Claude Code (https://claude.ai/code); hooks and synthesis need it."; fi
if command -v ollama >/dev/null 2>&1; then say "ok ollama found"; else say "! ollama not found: setup will offer to install it with Homebrew."; fi
say "ok node $(node -v)"

[ "$CHECK" -eq 1 ] && { say "Prerequisites look fine."; exit 0; }

if [ "$YES" -ne 1 ]; then
  say ""
  say "This will install Johnny with the recommended defaults:"
  say "  - build it and put 'johnny' on your PATH"
  say "  - install Ollama (Homebrew) and download two local models if missing (a few GB)"
  say "  - add Claude Code hooks and the Johnny MCP server (undo: johnny uninstall)"
  say "  - import your existing Claude Code sessions into ~/.johnny (stays on this Mac)"
  say "  - build facts, observations and mental models automatically every 3 hours using"
  say "    your 'claude' CLI (uses your Claude usage; sends memory text to Anthropic)"
  printf 'Continue? [Y/n] '
  read -r ANSWER || ANSWER=n
  case "$ANSWER" in ""|y|Y|yes|YES) ;; *) say "Cancelled. Nothing was changed."; exit 0 ;; esac
fi

if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run build
npm link || fail "npm link failed. If it is a permissions error, fix your npm prefix (or use nvm) and re-run."
command -v johnny >/dev/null 2>&1 || fail "'johnny' is not on your PATH after npm link; open a new terminal and re-run ./install.sh."

johnny setup --yes
johnny daemon start || true

say ""
say "Johnny is installed. Start Claude Code as usual; memory and knowledge now build in the background."
say "Check on it any time with: johnny doctor"
