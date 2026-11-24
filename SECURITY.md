# Security

Johnny stores your Claude Code session history in a local SQLite file (`~/.johnny/johnny.db`) and runs hooks and a background daemon as your user. Treat that file like your shell history: it can contain anything you or Claude typed.

## What Johnny does with data

- Stores session text locally. Nothing is uploaded by Johnny.
- Redacts common credential patterns (private keys, AWS keys, API tokens) before promoting text into the knowledge layer. Redaction is best-effort, not a guarantee.
- `johnny synth` sends memory text to the `claude` CLI you already run, which is subject to your Anthropic account's terms. Do not run it if that is not acceptable for your data.
- Synthesis runs the model with no tools, no MCP servers and a clean environment, and treats archived text as data, to limit prompt-injection from old sessions.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). Include steps to reproduce and the impact you see. I will acknowledge within a few days.

## Supported versions

Only the latest release on the default branch is supported.
