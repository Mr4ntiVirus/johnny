// Phase G cooldown logic. Pure module — no I/O, no DB access. Caller fetches
// the surface map and passes it in.
//
// Semantics (project_johnny_cooldown_semantics.md):
//   A memory enters cooldown when surfaced (offer/suggest/recommend/recall).
//   Two break conditions, OR-joined:
//     (a) currentTurn - lastSurfacedTurn >= cooldownTurns         (time)
//     (b) similarity(prompt, memory) >= subjectShiftThreshold     (subject)
//
//   Either break re-eligibles the memory; otherwise it's filtered out of
//   surface candidates this turn.

export interface CooldownGate {
  cooldownTurns: number;
  subjectShiftThreshold: number;
}

export interface CooldownContext {
  surfacedMap: Record<string, number>;
  currentTurn: number;
}

// True iff the memory should be HELD BACK from surfacing. Returns false for
// memories that have never been surfaced this session.
export function isInCooldown(
  memoryId: string,
  similarity: number | null,
  ctx: CooldownContext,
  gate: CooldownGate,
): boolean {
  const surfaceTurn = ctx.surfacedMap[memoryId];
  if (surfaceTurn === undefined) return false;

  // Break (a): time elapsed.
  if (ctx.currentTurn - surfaceTurn >= gate.cooldownTurns) return false;

  // Break (b): bullseye topical match overrides time. Null similarity (no
  // embedding available) cannot trigger this break — falls through to held.
  if (similarity !== null && similarity >= gate.subjectShiftThreshold) return false;

  return true;
}

// Filter scored candidates, dropping anything in cooldown. Preserves order.
// Memories without a similarity score (null) cannot exercise break (b) but
// can still exit via time-based break (a).
export function filterByCooldown<T extends { memory: { id: string }; score: number | null }>(
  candidates: T[],
  ctx: CooldownContext,
  gate: CooldownGate,
): T[] {
  return candidates.filter(c => !isInCooldown(c.memory.id, c.score, ctx, gate));
}
