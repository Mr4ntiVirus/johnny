import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput, useApp, render } from 'ink';
import TextInput from 'ink-text-input';
import { computeActivation } from '../../store/graph.js';
import { toNaturalLanguage } from '../../utils/transcript.js';
import type { MemoryFull, MemoryGraph, JohnnyConfig } from '../../types.js';

// Brand hex (mirrors tokens.ts — Ink uses hex directly)
const C = {
  cyan:    '#00FFE0',
  magenta: '#FF2EA6',
  green:   '#00FF66',
  amber:   '#FFB000',
  red:     '#FF3860',
  fg:      '#D8E4FF',
  dim:     '#4A5568',
  grid:    '#1A1F2C',
};

type Mode = 'list' | 'inspect' | 'search' | 'help';
type FilterView = 'all' | 'active' | 'dormant';

const formatTranscriptAsNaturalLanguage = toNaturalLanguage;

interface ScoredMemory {
  m: MemoryFull;
  activation: number;
  score: number;
  edgeCount: number;
}

function activationBar(activation: number): string {
  const filled = Math.round(activation * 8);
  return '█'.repeat(filled) + '░'.repeat(8 - filled);
}

function nodeColor(rank: number, activation: number): string {
  if (activation < 0.2) return C.dim;
  if (rank > 0.15)      return C.magenta;
  if (rank > 0.06)      return C.cyan;
  return C.green;
}

function fmt(n: number, d = 3): string { return n.toFixed(d); }

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ title }: { title: string }) {
  return (
    <Box borderStyle="single" borderColor={C.dim} paddingX={1}>
      <Text color={C.cyan} bold>JOHNNY</Text>
      <Text color={C.dim}> · {title}</Text>
    </Box>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer({ hints }: { hints: string }) {
  return (
    <Box borderStyle="single" borderColor={C.dim} paddingX={1} minHeight={1}>
      <Text color={C.dim}>{hints}</Text>
    </Box>
  );
}

// ── List view ─────────────────────────────────────────────────────────────────

function ListView({
  scored,
  cursor,
  filterText,
}: {
  scored: ScoredMemory[];
  cursor: number;
  filterText: string;
}) {
  const visible = filterText
    ? scored.filter(({ m }) =>
        m.snapshotName.includes(filterText) ||
        m.topics.some(t => t.includes(filterText)) ||
        m.summary.toLowerCase().includes(filterText.toLowerCase()),
      )
    : scored;

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text color={C.dim}>
          {'snapshot'.padEnd(30)}
          {'rank'.padEnd(8)}
          {'actv'.padEnd(8)}
          {'edges'.padEnd(6)}
          {'activation'}
        </Text>
      </Box>
      {visible.length === 0 && (
        <Text color={C.dim}>  no matches.</Text>
      )}
      {visible.map(({ m, activation, edgeCount }, i) => {
        const selected = i === cursor;
        const color = nodeColor(m.rank, activation);
        const bar = activationBar(activation);
        const prefix = selected ? '▶ ' : '  ';
        return (
          <Box key={m.id}>
            <Text color={selected ? C.amber : C.dim}>{prefix}</Text>
            <Text color={color} bold={selected}>
              {m.snapshotName.slice(0, 28).padEnd(30)}
            </Text>
            <Text color={C.dim}>{fmt(m.rank).padEnd(8)}</Text>
            <Text color={C.dim}>{fmt(activation, 2).padEnd(8)}</Text>
            <Text color={C.dim}>{String(edgeCount).padEnd(6)}</Text>
            <Text color={color}>{bar}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Inspect view ──────────────────────────────────────────────────────────────

function TranscriptBox({ text }: { text: string }) {
  const lines = text.split('\n');

  // Fixed 35 lines for content + 1 for indicator = 36 total
  const boxHeight = 35;
  const textLines = boxHeight - 1;
  const maxScroll = Math.max(0, lines.length - textLines);

  // Start at the tail — the unique delta content is at the end, not the head.
  // Same-session snapshots all share the same opening lines, so starting at
  // the bottom shows the distinct content that motivated this snapshot.
  const [scroll, setScroll] = useState(() => maxScroll);
  const pageSize = 5;

  useInput((input, key) => {
    if (key.downArrow) setScroll(s => Math.min(s + 1, maxScroll));
    else if (key.upArrow) setScroll(s => Math.max(s - 1, 0));
    else if (key.pageDown) setScroll(s => Math.min(s + pageSize, maxScroll));
    else if (key.pageUp) setScroll(s => Math.max(s - pageSize, 0));
    else if (input === 'g') setScroll(0);
    else if (input === 'G') setScroll(maxScroll);
  });

  const visible = lines.slice(scroll, scroll + textLines).join('\n');
  const pct = maxScroll > 0 ? Math.round((scroll / maxScroll) * 100) : 0;
  const atEnd = scroll >= maxScroll;
  const lineInfo = atEnd 
    ? `${lines.length}` 
    : `${scroll + 1}-${Math.min(scroll + textLines, lines.length)}`;

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor={C.grid} paddingX={1} height={boxHeight}>
        <Text color={C.fg}>{visible}</Text>
      </Box>
      <Box>
        <Text color={C.dim}> {lineInfo}</Text>
        {!atEnd && <Text color={C.dim}> +{pct}%</Text>}
      </Box>
    </Box>
  );
}

function InspectView({ m, activation, graph }: { m: MemoryFull; activation: number; graph: MemoryGraph<MemoryFull> }) {
  const color = nodeColor(m.rank, activation);
  const edges = Object.entries(m.outgoingEdges)
    .map(([toId, edge]) => ({ name: graph.memories[toId]?.snapshotName ?? toId, weight: edge.weight }))
    .sort((a, b) => b.weight - a.weight);

  function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
    return (
      <Box>
        <Text color={C.dim}>{label.padEnd(14)}</Text>
        <Text color={valueColor ?? C.fg}>{value}</Text>
      </Box>
    );
  }

  const transcriptNatural = formatTranscriptAsNaturalLanguage(m.transcript ?? '');

  return (
    <Box flexDirection="column" paddingX={2} flexGrow={1}>
      <Box marginBottom={1}>
        <Text color={color} bold>{m.snapshotName}</Text>
      </Box>
      <Row label="title"     value={m.title?.slice(0, 50) ?? '(none)'} />
      <Row label="topics"    value={m.topics.slice(0, 8).join(', ')} />
      <Row label="rank"      value={fmt(m.rank, 3)} valueColor={color} />
      <Row label="activ"     value={fmt(activation, 3)} valueColor={color} />
      <Row label="tokens"    value={String(m.tokenCount)} />
      <Row label="retrievals" value={String(m.retrievalCount)} />
      <Row label="created"    value={m.createdAt?.slice(0, 19) ?? '(none)'} />
      {edges.length > 0 && (
        <Box flexDirection="column" marginTop={0}>
          <Text color={C.dim}>links</Text>
          {edges.slice(0, 3).map(e => (
            <Box key={e.name}>
              <Text color={C.dim}>  → </Text>
              <Text color={C.cyan}>{e.name.slice(0, 28)}</Text>
            </Box>
          ))}
        </Box>
      )}
      {transcriptNatural && (
        <Box flexDirection="column" marginTop={1} flexGrow={1}>
          <Box marginBottom={0}>
            <Text color={C.amber}>conversation ({transcriptNatural.length} chars)</Text>
          </Box>
          <TranscriptBox text={transcriptNatural} />
        </Box>
      )}
    </Box>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

function GraphApp({
  graph,
  currentTurn,
  config,
}: {
  graph: MemoryGraph<MemoryFull>;
  currentTurn: number;
  config: JohnnyConfig;
}) {
  const { exit } = useApp();

  const scored: ScoredMemory[] = Object.values(graph.memories)
    .map(m => ({
      m,
      activation: computeActivation(m, currentTurn, config.activationTau),
      score: m.rank * computeActivation(m, currentTurn, config.activationTau),
      edgeCount: Object.keys(m.outgoingEdges).length,
    }))
    .sort((a, b) => b.score - a.score);

  const [mode, setMode]           = useState<Mode>('list');
  const [cursor, setCursor]       = useState(0);
  const [filterText, setFilter]   = useState('');
  const [searchDraft, setDraft]   = useState('');
  const [filterView, setFilterView] = useState<FilterView>('all');

  const viewFiltered = filterView === 'all' ? scored
    : filterView === 'active'
      ? scored.filter(s => s.activation >= 0.2)
      : scored.filter(s => s.activation < 0.2);

  const visible = filterText
    ? viewFiltered.filter(({ m }) =>
        m.snapshotName.includes(filterText) ||
        m.topics.some(t => t.includes(filterText)) ||
        m.summary.toLowerCase().includes(filterText.toLowerCase()),
      )
    : viewFiltered;

  const selected = visible[cursor] ?? null;

  const commitSearch = useCallback(() => {
    setFilter(searchDraft);
    setCursor(0);
    setMode('list');
  }, [searchDraft]);

  useInput((input, key) => {
    if (mode === 'search') {
      if (key.return)  { commitSearch(); return; }
      if (key.escape)  { setDraft(''); setFilter(''); setMode('list'); return; }
      return; // TextInput handles the rest
    }

    if (input === 'q' || key.escape) { exit(); return; }

    if (mode === 'list') {
      if (input === '?') { setMode('help'); return; }
      if ((input === 'j' || key.downArrow) && cursor < visible.length - 1) {
        setCursor(c => c + 1);
      }
      if ((input === 'k' || key.upArrow) && cursor > 0) {
        setCursor(c => c - 1);
      }
      if (key.return && selected) { setMode('inspect'); }
      if (input === '/') { setMode('search'); setDraft(filterText); }
      if (input === 'c') { setFilter(''); setCursor(0); }
      if (input === 'f') {
        setFilterView(v => v === 'all' ? 'active' : v === 'active' ? 'dormant' : 'all');
        setCursor(0);
      }
      if (input === 'e' && selected) {
        exit();
        // Export is handled post-exit in runGraphTui
        process.env._JOHNNY_TUI_EXPORT = selected.m.snapshotName;
      }
      return;
    }

if (mode === 'inspect') {
      if (key.escape || input === 'b') { setMode('list'); return; }
      return;
    }

    if (mode === 'help') {
      if (key.escape || input === '?' || input === 'q') { setMode('list'); return; }
      return;
    }
  });

  const totalSubjects = scored.length;
  const filterLabel = filterView !== 'all' ? ` · ${filterView}` : '';
  const headerTitle =
    mode === 'help' ? 'keyboard shortcuts'
    : mode === 'inspect' && selected
      ? selected.m.snapshotName
      : `memory graph · ${visible.length}/${totalSubjects} subjects · turn ${currentTurn}${filterText ? ` · "${filterText}"` : ''}${filterLabel}`;

  const footerHints =
    mode === 'help' ? '?/esc close · q quit'
    : mode === 'list'
      ? `j/k navigate · enter inspect · / search · f filter · c clear · ? help · q quit`
      : mode === 'inspect'
      ? 'esc/b back · q quit · ↑↓ scroll · g top · G bottom'
      : 'type to filter · enter confirm · esc cancel';

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 40}>
      <Header title={headerTitle} />

      <Box flexDirection="column" flexGrow={1}>
        {mode === 'search' && (
          <Box paddingX={2} marginY={1}>
            <Text color={C.amber}>/</Text>
            <TextInput
              value={searchDraft}
              onChange={setDraft}
              onSubmit={commitSearch}
            />
          </Box>
        )}

        {(mode === 'list' || mode === 'search') && (
          <ListView scored={visible} cursor={cursor} filterText={filterText} />
        )}

        {mode === 'help' && (
          <Box flexDirection="column" paddingX={2} paddingY={1}>
            <Text bold color={C.cyan}>Johnny Graph TUI</Text>
            <Box marginTop={1}>
              <Text color={C.dim}>navigation</Text>
            </Box>
            <Text color={C.fg}>  j/k or ↑/↓  select memory</Text>
            <Text color={C.fg}>  enter         inspect memory</Text>
            <Text color={C.fg}>  g/G           scroll to top/bottom</Text>
            <Box marginTop={1}>
              <Text color={C.dim}>actions</Text>
            </Box>
            <Text color={C.fg}>  /             search memories</Text>
            <Text color={C.fg}>  f             cycle filter (all/active/dormant)</Text>
            <Text color={C.fg}>  c             clear filters</Text>
            <Text color={C.fg}>  e             export selected memory</Text>
            <Box marginTop={1}>
              <Text color={C.dim}>general</Text>
            </Box>
            <Text color={C.fg}>  ?             show this help</Text>
            <Text color={C.fg}>  q or esc      quit</Text>
          </Box>
        )}

        {mode === 'inspect' && selected && (
          <InspectView m={selected.m} activation={selected.activation} graph={graph} />
        )}
      </Box>

      <Footer hints={footerHints} />
    </Box>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runGraphTui(
  graph: MemoryGraph<MemoryFull>,
  currentTurn: number,
  config: JohnnyConfig,
): Promise<void> {
  const { waitUntilExit } = render(
    <GraphApp graph={graph} currentTurn={currentTurn} config={config} />,
  );
  await waitUntilExit();
}
