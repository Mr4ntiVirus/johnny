#!/usr/bin/env node
// johnny — agentic memory librarian for Claude Code

// Command and hook modules load on demand, inside the case that runs them. The hooks
// (evaluate, post-turn, ...) fire on every prompt and tool call, and loading all 38 modules
// up front used to cost ~150 ms of a ~200 ms hook call. Keep this file free of static imports
// from ./commands and the hook modules (tests/cli/cli-subprocess.test.ts enforces it).

const [, , cmd, ...args] = process.argv;

// ── top-level help ───────────────────────────────────────────────────────────
// `johnny --help` / `johnny help` prints the command list and exits.
// For individual commands, --help is either handled inside the command
// (graph, recall, remember) or — for commands that take no args and mutate
// user state (install, rollback, snapshot-now, setup, bootstrap, daemon,
// enable, disable) — we short-circuit here to avoid accidentally firing
// a destructive action when the user just wants the docs.
const USAGE = `
  johnny — agentic memory librarian

  usage:
    johnny                          run claude under johnny (auto-setup if needed)
    johnny <command> [args...]      run a johnny subcommand

  commands:
    setup         first-run setup (create ~/.johnny, pull models, wire hooks)
    bootstrap     ingest prior claude sessions into the memory graph
    install       write hooks to ~/.claude/settings.json (--tool-prime adds the opt-in PreToolUse hook)
    uninstall     remove hooks from ~/.claude/settings.json
    enable        clear the ~/.johnny/disabled sentinel
    disable       set the ~/.johnny/disabled sentinel (bypass all hooks)
    status        health check · memory stats
    graph         inspect the memory graph (--json, --tui, --help)
    recall        search memories (--list, --switch, --help)
    remember      save a memory manually (--content=, --help)
    dump          export a memory's transcript
    watch         watch a transcript file live
    snapshot-now  manual CMV checkpoint of the current session
    rollback      restore the last auto-snapshot
    daemon        start | stop | restart | status | (no-arg) foreground run
    sleep         manual sleep-phase consolidation
    detect        probe which runtime tools are available
    mcp           run the MCP server (stdio)
    prune-edges   prune edges over topKOutgoing cap (--dry-run, --json)
    schemas       inspect / approve / reject quarantined schema gist nodes
    eval-recall   read-only retrieval-quality report (--replay=N, --out=file.json)
    dedupe        purge duplicate chunks (dry run; --apply)
    synth         knowledge synthesis: run | status [--exit-code] | resume | jobs
    models        inspect/override compiled mental models (list, show, refresh, add)
    eval-knowledge  coverage of compiled knowledge vs your hand-written memory notes
    eval-prime    priming precision on real recent prompts (read-only; --tool replays shell commands)
    eval-recommend  precision of legacy memory hints by cosine band (read-only)
    resummarize   rewrite generic memory summaries from stored text (dry run; --apply, --revert)

  hooks (invoked by Claude Code, not typed by users):
    evaluate      UserPromptSubmit
    pre-compact   PreCompact
    post-compact  PostCompact
    post-turn     PostToolUse
    pre-tool      PreToolUse (mid-turn knowledge priming; off unless knowledge.prime)

  see \`johnny <command> --help\` for per-command options where supported
`;

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

// Commands whose arg parser doesn't handle --help themselves — guard against
// the user running `johnny install --help` and accidentally installing.
const GUARDED_NO_ARG_COMMANDS = new Set([
  'install', 'uninstall', 'enable', 'disable', 'status',
  'snapshot-now', 'rollback', 'sleep', 'setup', 'bootstrap',
  'detect', 'daemon',
]);
if (GUARDED_NO_ARG_COMMANDS.has(cmd ?? '') && (args.includes('--help') || args.includes('-h'))) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// Commands excluded from the centralized process.exit(0):
// - 'daemon' (foreground) and '' (cmdLaunch) are long-running / self-managed.
// - 'mcp' runs a persistent stdio server — same reasoning.
// - Hooks (evaluate, pre-compact, post-compact, post-turn): hooks write
//   their result as JSON to stdout (HookOutput.decision/additionalContext);
//   a forced process.exit(0) risks truncating that write before the pipe flushes.
const SELF_MANAGED_LIFECYCLE = new Set([
  'daemon', '', 'mcp',
  'evaluate', 'pre-compact', 'post-compact', 'post-turn', 'pre-tool',
]);

async function main(): Promise<void> {
  switch (cmd ?? '') {
    case 'disable':     await (await import('./commands/bypass.js')).cmdDisable();         break;
    case 'enable':      await (await import('./commands/bypass.js')).cmdEnable();           break;
    case 'install':     await (await import('./commands/install.js')).cmdInstall(args);      break;
    case 'uninstall':   await (await import('./commands/uninstall.js')).cmdUninstall();        break;
    case 'status':      await (await import('./commands/status.js')).cmdStatus();           break;
    case 'graph':       await (await import('./commands/graph.js')).cmdGraph(args);        break;
    case 'rollback':    await (await import('./commands/rollback.js')).cmdRollback();         break;
    case 'sleep':       await (await import('./commands/sleep.js')).cmdSleep();            break;
    case 'setup':         await (await import('./commands/setup.js')).cmdSetup(args);            break;
    case 'recall':        await (await import('./commands/recall.js')).cmdRecall(args);       break;
    case 'snapshot-now':  await (await import('./commands/snapshot-now.js')).cmdSnapshotNow();      break;
    case 'bootstrap':     await (await import('./commands/bootstrap.js')).cmdBootstrap();         break;
    case 'dump':          await (await import('./commands/dump.js')).cmdDump(args);           break;
    case 'watch':         await (await import('./commands/watch.js')).cmdWatch(args);          break;
    case 'remember':    await (await import('./commands/remember.js')).cmdRemember(args);    break;
    case 'skills':      await (await import('./commands/skills.js')).cmdSkills(args);      break;
    case 'show':        await (await import('./commands/show.js')).cmdShow(args);         break;
    case 'validate':    await (await import('./commands/validate.js')).cmdValidate();          break;
    case 'doctor':      await (await import('./commands/doctor.js')).cmdDoctor(args);        break;
    case 'stats':       await (await import('./commands/stats.js')).cmdStats(args);         break;
    case 'prune-edges': await (await import('./commands/prune-edges.js')).cmdPruneEdges(args);    break;
    case 'schemas':     await (await import('./commands/schemas.js')).cmdSchemas(args);         break;
    case 'eval-recall': await (await import('./commands/eval-recall.js')).cmdEvalRecall(args);      break;
    case 'dedupe':      await (await import('./commands/dedupe.js')).cmdDedupe(args);          break;
    case 'synth':       await (await import('./commands/synth.js')).cmdSynth(args);           break;
    case 'models':      await (await import('./commands/models.js')).cmdModels(args);          break;
    case 'eval-knowledge': await (await import('./commands/eval-knowledge.js')).cmdEvalKnowledge(args);    break;
    case 'eval-prime':  await (await import('./commands/eval-prime.js')).cmdEvalPrime(args);           break;
    case 'eval-recommend': await (await import('./commands/eval-recommend.js')).cmdEvalRecommend(args);    break;
    case 'resummarize': await (await import('./commands/resummarize.js')).cmdResummarize(args);         break;
    case 'detect':      await import('./commands/detect.js').then(m => m.detectAll().then(console.log)); break;
    case 'mcp':
      // Run the MCP server in the foreground (stdio).
      {
        const { runMcpServer } = await import('../mcp/index.js');
        await runMcpServer();
      }
      break;
    case 'evaluate':     await (await import('./evaluate.js')).runEvaluate();          break;
    case 'pre-compact':  await (await import('./pre-compact.js')).runPreCompact();        break;
    case 'pre-tool':     await (await import('./pre-tool.js')).runPreTool();           break;
    case 'post-compact': await (await import('./post-compact.js')).runPostCompact();       break;
    case 'post-turn':    await (await import('./post-turn.js')).runPostTurn();          break;

    case 'daemon':
      // `johnny daemon` with no args runs in foreground.
      // `johnny daemon start|stop|status` manages background process.
      if (args.length === 0) {
        const { runDaemon } = await import('../daemon/index.js');
        await runDaemon();
      } else {
        await (await import('./commands/daemon.js')).cmdDaemon(args);
      }
      break;

    case '':
      // No args → auto-setup if needed, start daemon, launch claude
      await (await import('./commands/launch.js')).cmdLaunch(args);
      break;

    default:
      console.error(`johnny: unknown command '${cmd}'`);
      console.error('usage:    johnny [claude-args...]');
      console.error('commands: setup | bootstrap | install | uninstall | status | graph | recall | remember | dump | watch | snapshot-now | enable | disable | rollback | daemon | sleep | detect | mcp | prune-edges');
      console.error('hooks:    evaluate | pre-compact | post-compact | post-turn');
      console.error('try:      johnny <command> --help');
      process.exit(1);
  }
}

if (SELF_MANAGED_LIFECYCLE.has(cmd ?? '')) {
  await main();
} else {
  await main();
  // Exit only after stdout has flushed — piped output (e.g. `johnny graph --json | jq`)
  // is truncated by an immediate process.exit(0).
  process.stdout.write('', () => process.exit(0));
}
