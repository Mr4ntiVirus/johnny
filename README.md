# Johnny Neuromorphic

[![CI](https://github.com/Mr4ntiVirus/johnny/actions/workflows/ci.yml/badge.svg)](https://github.com/Mr4ntiVirus/johnny/actions/workflows/ci.yml)

**A local memory librarian for Claude Code.** Johnny Neuromorphic by Positronik.

Johnny remembers what you worked on across sessions, notices when a new prompt touches something you have done before, and quietly puts the right context in front of Claude. Everything runs on your Mac: one SQLite file, local embeddings through Ollama, no accounts, no servers, no telemetry.

> Status: v0.1, Mac only (Apple Silicon). Built for one person's daily use and now open for others. Expect rough edges, and read "Limitations" below before relying on it.

## What it does

- **Captures sessions as memories.** A Claude Code hook snapshots only the *new* part of each session, splits it into chunks, embeds them locally, and stores them in `~/.johnny/johnny.db`.
- **Recalls by meaning.** Each prompt is matched against your memories (dense embeddings plus a lexical lane). When something relevant exists, Johnny surfaces a short digest to Claude instead of making you re-explain.
- **Compiles knowledge in the background, automatically.** Every 3 hours Johnny reads new memories and extracts verified **facts**, merges them into **observations**, and builds standing **mental models** (short prose answers to recurring questions). Every fact must quote its source; unsupported ones are rejected.
- **Exposes MCP tools** so Claude can look things up on purpose: `johnny_remember`, `johnny_recall`, `johnny_search`, `johnny_list`, `johnny_graph`, `johnny_invalidate`, `johnny_models`, `johnny_reflect`.
- **Ships a doctor.** `johnny doctor` is a live terminal dashboard (daemon, Ollama, hook activity, memory and knowledge stats), and an optional menu-bar tray shows the same data.

Memory is a graph: edges strengthen when memories are recalled together, PageRank gives structural importance, and activation decays with turns rather than wall-clock time.

## What it deliberately does not do

No cloud sync, no hosted service, no email or inbox features, no database server. Your memories never leave your machine, with one exception you control: automatic synthesis shells out to the `claude` CLI you already use to extract facts, so the text of the memory being processed goes to Anthropic exactly as it does in a normal Claude Code session. Secrets are redacted before anything is stored as knowledge. If you decline synthesis at setup, nothing leaves your machine.

## Requirements

- macOS on Apple Silicon (Intel is untested)
- Node.js 20 (developed and tested on Node 20; other versions are untested)
- [Claude Code](https://claude.ai/code) (the `claude` CLI)
- [Ollama](https://ollama.com), with two models: `mxbai-embed-large` (embeddings) and `qwen2.5:3b` (intent classifier). `johnny setup` offers to install Ollama and pull both.

Johnny still works without Ollama in a degraded mode (keyword heuristics only); memories captured while Ollama is down are embedded later.

## Install

One command:

```bash
git clone https://github.com/Mr4ntiVirus/johnny.git
cd johnny
./install.sh
```

`install.sh` checks your prerequisites, asks **once**, and then does everything: builds Johnny, puts `johnny` on your PATH, installs Ollama (Homebrew) and the two local models if they are missing, wires the Claude Code hooks and MCP server, imports your existing Claude Code sessions from `~/.claude/projects` into the local database, turns on automatic knowledge synthesis, and starts the background daemon. Use `./install.sh --yes` to skip the question, or `./install.sh --check` to only check prerequisites.

After that there is nothing to run: memories are captured as you work, and facts, observations and mental models are built in the background every 3 hours (see below).

Prefer to do it step by step?

```bash
npm install && npm run build && npm link
johnny setup        # asks before installing Ollama, downloading models, and enabling synthesis (--yes accepts all)
johnny daemon start
```

`johnny uninstall` removes the hooks, slash commands, MCP registration and the synthesis job. Your data in `~/.johnny` is left alone.

## Automatic knowledge synthesis

Turning memories into facts, observations and mental models happens on its own. A small launchd job runs `johnny synth run` every 3 hours; it first does a free check and exits at once if nothing new is pending. When there is work, it runs your `claude` CLI headlessly (no tools, capped per run and per day) and the results show up in recall and in the doctor's KNOWLEDGE panel. The daemon re-arms the job if it ever goes missing.

This is the one place memory text leaves your machine (to Anthropic, through the `claude` CLI you already use, and it counts against your Claude usage), so `johnny setup` asks before enabling it. Decline there, or run `johnny synth disarm` later, and Johnny still captures and recalls memories; you just get no compiled knowledge. `johnny synth run --verbose` does one pass on demand.

## Everyday use

```bash
johnny doctor                 # live dashboard (q to quit, r to restart the daemon)
johnny doctor --once          # one text snapshot
johnny status                 # quick health check
johnny recall "billing bug"   # search your memories from the shell
johnny remember "..."         # store a note on purpose
johnny synth status           # what knowledge work is pending (no model calls)
johnny synth run --verbose    # one governed synthesis pass now
johnny synth arm / disarm     # turn the automatic 3-hourly synthesis on or off
johnny models list            # compiled mental models
johnny graph                  # the memory graph
```

Escape hatches: `johnny disable` bypasses every hook, `JOHNNY_BYPASS=1 claude` bypasses one session, and `touch ~/.johnny/disabled` works even if the CLI is broken.

In Claude Code, `/recall`, `/remember`, `/snapshot` and `/jstatus` are installed as slash commands.

## Menu-bar tray

`tray/` contains a small Electron menu-bar app that polls `johnny doctor --json`. It is optional:

```bash
cd tray && npm install && npm start
```

## How the pieces fit

| Piece | Where | Role |
|---|---|---|
| Hooks | `src/cli/` | `evaluate` (every prompt), `pre-compact`, `post-compact`, `post-turn`; optional `pre-tool` |
| Decision engine | `src/engine/` | heuristics, embeddings, classifier, and the choice of what to surface |
| Storage | `src/store/` | SQLite via `better-sqlite3`; one file, `~/.johnny/johnny.db` |
| Knowledge layer | `src/knowledge/` | facts, observations, mental models, priming |
| MCP server | `src/mcp/` | the `johnny_*` tools |
| Daemon | `src/daemon/` | model warmer, session watcher, rank refresher, embedding backfill, idle consolidation |
| Doctor | `src/cli/commands/doctor.tsx`, `tray/` | terminal dashboard and tray |

More detail on the knowledge layer is in [docs/KNOWLEDGE.md](docs/KNOWLEDGE.md); the `remember` flow is in [docs/REMEMBER.md](docs/REMEMBER.md).

## Configuration

`~/.johnny/config.json` is created on first run; every value is optional. Knowledge-layer settings live under a `knowledge` key (see docs/KNOWLEDGE.md). Models can be overridden with `JOHNNY_EMBED_MODEL`, `JOHNNY_CLASSIFY_MODEL` and `JOHNNY_OLLAMA_URL`.

## Limitations

- Mac only for now; Linux and Windows are not supported.
- Tested on one machine, with one person's usage. The scoring thresholds were tuned on that data and may need adjusting for yours.
- Priming and recall can surface a memory that is related but not useful. Measured precision numbers and known failure modes are in docs/KNOWLEDGE.md.
- Synthesis uses the `claude` CLI under your own subscription and has per-run and per-day caps (`knowledge.synth` config).
- Early software: back up `~/.johnny/` if the memories matter to you.

## Development

```bash
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm test             # vitest (in-memory SQLite, deterministic mock for Ollama; no network needed)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). `src/vendor/cmv/` is vendored from [claude-code-cmv](https://github.com/CosmoNaught/claude-code-cmv) under its own Apache-2.0 license.
