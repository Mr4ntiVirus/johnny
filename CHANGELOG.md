# Changelog

## 0.1.0

First public release. Mac only, local only.

- Session capture, chunking and local embeddings (Ollama) into a single SQLite database.
- Per-prompt recall and priming from memories and compiled knowledge.
- Knowledge layer: facts, observations and mental models via `johnny synth`.
- MCP server with `johnny_remember`, `johnny_recall`, `johnny_search`, `johnny_list`, `johnny_graph`, `johnny_invalidate`, `johnny_models`, `johnny_reflect`.
- Background daemon, `johnny doctor` terminal dashboard and optional menu-bar tray.
