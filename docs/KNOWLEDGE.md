# Johnny knowledge layer — design and operations

Johnny stores session memories as chunks and recalls them well. The knowledge layer adds what a human memory does without being asked: it **reflects on what it has stored and crystallizes it** into verified knowledge, then **brings the right piece forward** for the task at hand. It is modelled on Hindsight (vectorize-io; arXiv 2512.12818) and differs in one respect that matters: every function is automatic.

## Principle: subconscious, not commanded

Recall, priming, fact extraction, consolidation, model creation/refresh, deduplication, staleness and supersession all run without anyone prompting the memory system or approving anything. **Introspection is the opt-in exception**: Claude (or the user) can search, read and challenge memory at will, but the system is complete if introspection is never used. CLI/MCP commands are overrides and diagnostics, never required steps. Human review gates are replaced by automated quality gates whose results appear in the doctor's KNOWLEDGE panel and `johnny synth status`.

## Layers

| Layer | Table(s) | Produced by | Notes |
|---|---|---|---|
| Chunks | `chunks` | snapshot hook | write-time `content_hash` dedup; local-only |
| Facts | `facts`, `fact_entities`, `extraction_log` | `extract.ts` | ≤500-char statements, each with an exact `source_quote`; kinds decision/state/convention/event/lesson |
| Observations | `observations`, `observation_evidence`, `knowledge_history` | `consolidate.ts` | one facet each; `proof_count` = distinct sessions; supersede/retire, never delete |
| Mental models | `mental_models`, `knowledge_history` | `autocreate.ts`, `refresh.ts` | standing prose answers to a question; auto-created from observation clusters; 100% verified refresh |

Scope is the git root of the memory's project path, plus `global` for cross-project conventions.

## Data flow

1. A snapshot hook captures only **new** messages (`snapshot-delta.ts`: per-session anchor uuid + global `snapshot_ledger`) and stores only **new** chunks (hash guard).
2. `johnny synth run` (launchd heartbeat, armed by `johnny setup`; the daemon re-arms it if it goes missing) pulls pending memories, builds ~1,200-token windows, and asks Claude (tool-less) for facts. Each fact is kept only if its quote is found in the window.
3. A sampled second prompt verifies facts; unsupported ones are disputed. High rejection rates auto-pause the step.
4. New facts per scope are consolidated into observations via create/update/supersede/retire ops with short ids, validated for ids, evidence, and invented numbers.
5. Clusters of observations become mental models; stale models are rebuilt (gate first → zero tokens when fresh) and verified against their evidence before replacing the old text.
6. On each prompt (`evaluate`) a trusted, relevant, not-yet-seen model section or observation is primed as a short digest (matched against the model's *sections*, so only the section that answers the prompt is injected). An opt-in `PreToolUse` hook (`johnny install --tool-prime`) does the same for shell commands, but Claude Code attaches that context next to the tool result — so it prevents repeats of a mistake within a turn, not the first failing call — and it stays off because it is not precise enough (about 43% of its fires at the shipped floor were irrelevant); its process cost, about 50 ms per call since the lazy router, is no longer the blocker. See "Tool-time priming (measured 2026-10-15)" below. MCP tools expose the same layers for deliberate lookup.

## Hook output format (important)

Claude Code only injects hook context from `hookSpecificOutput.additionalContext` (or plain stdout). A top-level `additionalContext` key is **silently ignored** — Johnny emitted exactly that until 2026-10-12, so offer/recommend/bootstrap hints never reached the model. `src/utils/hook-output.ts` now converts at the single stdout write. The old forced per-turn "search memory" nudge was dead for the same reason. Fixing the output shape would have revived *all* of those legacy hints (offer / recommend / suggest / hard-switch announcements / bootstrap / nudge) — explicit "go call johnny_recall" instructions that contradict the subconscious principle — delivered again by default (`knowledge.legacyHints`, default `true`; set `false` to let only compiled-knowledge priming through). The forced per-turn search nudge stays retired (`retireSearchNudge`) because priming replaces it. Their JSONL-side behavior is unchanged. Machine-generated prompts (background-task notifications, local-command caveats, session-continuation summaries) are passed through untouched: classifying them produced bogus context switches.

## Safety properties

- **Untrusted input**: memory text may contain emails/web pages with instructions. The synthesizer has no tools, no MCP, no session persistence, a clean environment, and an output schema; the prompts state that archived text is data.
- **Secrets**: `redact.ts` strips credentials before anything is stored or sent anywhere. Memory text is only ever sent to the Claude CLI you already run (see Data flow).
- **No data loss**: only the one-time, backed-up duplicate purge deletes; the standing sweep removes straggler duplicate *chunk rows* only.
- **Bounded cost**: per-run and per-day call/token caps, a time box, and exponential backoff on rate/usage limits (`governor.ts`).
- **Rollback**: `config.knowledge.prime=false` disables all priming instantly; `johnny synth disarm` stops the heartbeat; `johnny disable` bypasses every hook.

## Operating it

Priming precision (measured with `johnny eval-prime` on real recent prompts, read-only): thresholds are cosine similarities against a model's best-matching *section* (`primeMinSimilarity` 0.70 on trigger turns, 0.75 on continuation turns (the config defaults; earlier text said 0.66/0.72), 0.53 for shell commands, which embed poorly against prose); a second item must score within 0.06 of the first. At those settings priming fired on ~24% of that earlier sample (a 2026-10-13 replay at 0.70/0.75 fires on 43%; see Known defects) with no ride-alongs; the earlier 0.55 setting fired on 71% and let a generic model ride along on most.

```bash
johnny synth status                 # what is pending (no model calls)
johnny synth run --verbose          # one governed pass now
johnny synth arm                    # headless heartbeat every 3h (setup arms it when you agree)
johnny synth resume extract         # clear an auto-pause after investigating
johnny models list | show <slug> --history
johnny eval-recall --replay=40 --out=report.json   # retrieval quality; diff before/after
johnny eval-knowledge               # coverage vs the hand-written notes in ~/.claude/projects/*/memory
johnny eval-prime                   # priming precision on real recent prompts (read-only)
johnny eval-prime --tool            # replay real Bash commands through the tool-time (PreToolUse) decision, production rules simulated
johnny synth reset-knowledge --yes  # drop DERIVED knowledge to recompile (raw memories untouched)
johnny dedupe                       # dry run of the duplicate purge; --apply needs daemon stopped + hooks disabled
```

Config (`~/.johnny/config.json`, all optional):

```json
{ "knowledge": { "prime": true, "legacyHints": false, "retireSearchNudge": true,
  "synth": { "defaultModel": "sonnet", "maxCallsPerRun": 80, "maxCallsPerDay": 400, "timeBoxMinutes": 75 } } }
```

## Knowledge pages

Compiled models are mirrored as plain markdown at `~/.johnny/knowledge/<scope>/<slug>.md` (YAML frontmatter + the model text) after every synthesis run, so they can be grepped and read with ordinary tools. The database is the source of truth; the files are a regenerable projection.

## Seeing it work: the doctor's KNOWLEDGE panel

`johnny doctor` (and `--once`, and `johnny stats --json` → `knowledge`) shows whether the layer is alive, so a silent failure cannot hide:

- **layers** — active facts → observations → models.
- **prime** — events primed / evaluated over 24h and 7d, from the `prime_events` table (one row per decision: `primed`, `none` or `failed`, 30-day retention). Failures (e.g. an Ollama embedding 500) are counted in red because the hook itself swallows them.
- **synth** — heartbeat health. Judged by the last run's *errors*, not its `stopped` label (a run where every model call failed with "Not logged in" was labelled `done`). States: `✓ armed`, `⏸ budget-day|rate-limit|backoff` (gated, expected), `× failed`, `× stalled` (armed, work pending, no run in 2 intervals), `× not armed`.
- **quality** — disputed facts and the last run's verifier rejection rate.

Row formatting is one pure function (`src/store/knowledge-view.ts`) shared by the TUI and the text fallback; rows are truncated to the half-width column, never wrapped.

## Known limits / later

Knowledge tables are local-only. No entity-resolution table, causal links, BM25/cross-encoder rerank, or Hindsight-style disposition/opinion confidence.

## Tool-time priming (measured 2026-10-15)

The opt-in `PreToolUse` hook (`johnny install --tool-prime`) stays off. Three things were measured so the question has an answer instead of a guess.

**Cost.** Every hook used to go through a CLI router that statically imported all 38 command and hook modules, so a hook call cost about 200 ms, roughly 75% of it import work. The router now loads each module on demand (`src/cli/index.ts`; `tests/cli/cli-subprocess.test.ts` fails if a static import returns). Interleaved A/B on an Apple Silicon Mac: `pre-tool` 204 -> 49 ms when it exits at once, 216 -> 55 ms when throttled, 303 -> 138 ms for the once-a-minute scan; `post-turn` 206 -> 54 ms; `evaluate` 2.64 -> 2.44 s. Process cost is no longer the blocker: about 0.05 s per Bash call, 0.14 s for the one scan per minute.

**Events** (Claude Code 2.1.301, real `claude -p`). A failing Bash call fires `PreToolUse` then `PostToolUseFailure` (payload has `error`), not `PostToolUse`; a successful one fires `PreToolUse` then `PostToolUse`. Context returned by all three reached the model. So `post-turn` (registered on PostToolUse only) never runs after a failed tool call, and failure-triggered priming would be a separate `PostToolUseFailure` registration.

**Precision** (`johnny eval-prime --tool`: 1,400+ real Bash calls from 30 recent sessions with the production rules simulated - trivial filter, one scan per minute per session, once per context epoch; 155 judgments by Claude, labels fixed in `tests/fixtures/tool-prime-labels.json`, hash and verdict only):

| floor | fires per 100 Bash calls | judged (distinct) | helpful | neutral | irrelevant |
|---|---|---|---|---|---|
| 0.53 (shipped) | 25 | 129 (116) | 29% | 28% | 43% |
| 0.68 | 12 | 58 (52) | 50% | 43% | 7% |
| 0.72 | 7 | 49 (44) | 61% | 35% | 4% |
| 0.76 | 3 | 43 (39) | 58% | 37% | 5% |

The judged sample is stratified by similarity band, not proportional to it, so rows below 0.72 are approximate (re-weighting by band gives about 28/30/42% at 0.53 and 54/43/2% at 0.72); the 0.76 row is exact (all 43 fires judged, 39 distinct label keys). "Judged" counts fires; a repeated command with the same refs shares one verdict, hence the distinct count.

Below 0.68, 63-71% of fires are irrelevant (the 0.63-0.68 band had no helpful fire at all), and the shipped floor fires on two thirds of scans: the "other gates keep it quiet" assumption did not hold. Query by failure text instead of the command: 93% of failures fire at 0.53, but only 11 of 45 at 0.68, 4 at 0.72 and none at 0.76 (volume too small to judge or to matter).

**Gate** (written before measuring): at least 30 judged fires, helpful >= 70% (prompt-time priming cleared 72%), irrelevant <= 5%, at most 5 fires per 100 calls, lean-hook p50 <= 100 ms. At 0.76 it meets sample size, irrelevant (4.7%) and noise (3.0 per 100) but misses helpful (58%) and, as written, latency (138 ms for the scan; 49-55 ms for every other call). Outcome: fail, `PreToolUse` stays off. Caveats: n is small, the judge shares the compiler's model family, the models were compiled from these same sessions, and a few repetitive automated workflows dominate the fires.

**If it is revisited:** raise `knowledge.primeToolSimilarity` from 0.53 to about 0.76 before anyone opts in (that alone removes the noise); the lever for the missing helpfulness is better matching of commands against model sections, not more gates.

## Recall mechanics (2026-10-13)

Chunk-first retrieval is hybrid: dense cosine plus a lexical lane. Chunks containing a rare query term (present in 1..60 chunks) get a +0.12 ordering bonus in `ChunkIndex.search` (reported cosine unchanged). Compiled tiles (models/observations/facts) lead the result but raw chunks keep a floor of 3 of the 8 slots so an exact-term chunk cannot be crowded out.
