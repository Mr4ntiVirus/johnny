# Knowledge acceptance probes

These probes failed (or answered badly) against the pre-knowledge store and must pass after the
phases ship. They are executed by `johnny eval-recall` (`loadAcceptanceProbes()` in
`src/cli/commands/eval-recall.ts`) against the real local store and checked by hand through the
real client (a `claude -p` session with the hooks active).

Probes are chosen so the answer is **not** already in always-loaded context (CLAUDE.md / MEMORY.md),
so passing them proves retrieval and priming, not the loaded index.

| Probe | Query | Must surface |
|---|---|---|
| search-design | `chunked retrieval rerank synthesis` | the chunked-retrieval + small-model rerank design |
| db-relay-location | `where does the database relay live` | the mTLS relay at relay.example.com:8443 |
| cursor-reset-bug | `snapshot delta cursor reset after trim` | the line-cursor reset that re-captured history |
| build-server-type | `which instance type runs the build server` | the build server's instance type |

Define your own probes in `~/.johnny/probes.json` as
`[{ "name": "...", "query": "...", "mustMatch": "regex" }]`; the table above is an example set.

Amnesia scenario (manual, via the real client): in a fresh session whose cwd has no AWS notes,
run an `aws` command; with priming on, the PreToolUse hook must inject the compiled
"Conventions and environment" model (default profile) *before* the call.

Automation acceptance (no CLI, no MCP call by the user): a brand-new session's first prompt about the
relay receives a digest; a fact contradicted in a later session is superseded and the affected model
is refreshed by the next heartbeat; the same chunk written twice is stored once.
