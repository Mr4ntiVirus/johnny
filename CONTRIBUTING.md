# Contributing

Thanks for looking. Johnny is a small, local-only project, so the process is light.

## Ground rules

- **Local only.** No cloud services, accounts, telemetry, or network calls other than `localhost` Ollama and the `claude` CLI. Pull requests that add them will not be merged; build those outside Johnny.
- **Mac first.** Keep changes working on macOS (Apple Silicon). Portable code is welcome, but Linux and Windows are not supported yet.
- **No data loss.** Anything that deletes memories needs a backup step and a test.
- **Hooks must stay fast.** Hook commands run on Claude Code's interactive path. The CLI router in `src/cli/index.ts` loads commands lazily on purpose; `tests/cli/cli-subprocess.test.ts` fails if a static import slips in.

## Setup

```bash
npm install
npm run build
npm test
```

Tests use an in-memory SQLite database and `JOHNNY_LLM_MOCK=1`, so they need neither Ollama nor network. If you change behavior, add or update a test next to the code it covers.

## Pull requests

- Keep them focused; explain the problem before the solution.
- Run `npm run typecheck && npm test` first.
- Do not include personal data (real prompts, transcripts, hostnames, keys) in fixtures or issues. Use synthetic examples.

## Reporting bugs

Open an issue with your macOS and Node versions, what you ran, and the relevant lines from `~/.johnny/johnny.log` (redact anything private). For security issues see [SECURITY.md](SECURITY.md).
