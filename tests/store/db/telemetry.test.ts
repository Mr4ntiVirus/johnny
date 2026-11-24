import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as telemetry from '../../../src/store/db/telemetry.js';

describe('db/telemetry.ts', () => {
  useTestDb();

  it('logHintEmission persists with JSON-encoded id list', async () => {
    await telemetry.logHintEmission({
      sessionId: 's',
      form: 'form3',
      suggestedMemoryIds: ['m1', 'm2'],
      topScore: 0.82,
      threshold: 0.7,
      tokenEstimate: 340,
    });
    const rows = await telemetry.getHintTelemetry();
    expect(rows).toHaveLength(1);
    expect(rows[0].form).toBe('form3');
    expect(rows[0].session_id).toBe('s');
    expect(rows[0].top_score).toBe(0.82);
    expect(JSON.parse(rows[0].suggested_memory_ids!)).toEqual(['m1', 'm2']);
  });

  it('logRecallCall round-trips name and chunk-id arrays', async () => {
    await telemetry.logRecallCall({
      sessionId: 's',
      query: 'auth flow',
      requestedNames: ['oauth-token-flow'],
      excludedChunkIds: ['oauth-token-flow#0'],
      chunksReturned: 3,
      memoryIds: ['m-oauth'],
    });
    const rows = await telemetry.getRecallTelemetry();
    expect(rows).toHaveLength(1);
    expect(rows[0].chunks_returned).toBe(3);
    expect(JSON.parse(rows[0].memory_ids!)).toEqual(['m-oauth']);
    expect(JSON.parse(rows[0].requested_names!)).toEqual(['oauth-token-flow']);
  });

  it('logRecallCall handles minimal input (no query/names/excludes)', async () => {
    await telemetry.logRecallCall({ sessionId: 's', chunksReturned: 0, memoryIds: [] });
    const rows = await telemetry.getRecallTelemetry();
    expect(rows[0].query).toBeNull();
    expect(rows[0].requested_names).toBeNull();
    expect(rows[0].excluded_chunk_ids).toBeNull();
  });

  it('getHintTelemetry returns most-recent first', async () => {
    await telemetry.logHintEmission({ sessionId: 's', form: 'form1', suggestedMemoryIds: [] });
    await new Promise(r => setTimeout(r, 5));
    await telemetry.logHintEmission({ sessionId: 's', form: 'form2', suggestedMemoryIds: [] });
    const rows = await telemetry.getHintTelemetry();
    expect(rows.map(r => r.form)).toEqual(['form2', 'form1']);
  });

  it('computeConversionRollup yields zero-rate when no events', async () => {
    const r = await telemetry.computeConversionRollup();
    expect(r).toEqual({ hintsEmitted: 0, recallsTriggered: 0, conversionRate: 0 });
  });

  it('computeConversionRollup divides recalls by hints in window', async () => {
    await telemetry.logHintEmission({ sessionId: 's', form: 'form3', suggestedMemoryIds: ['m1'] });
    await telemetry.logHintEmission({ sessionId: 's', form: 'form3', suggestedMemoryIds: ['m2'] });
    await telemetry.logRecallCall({ sessionId: 's', chunksReturned: 1, memoryIds: ['m1'] });
    const r = await telemetry.computeConversionRollup();
    expect(r.hintsEmitted).toBe(2);
    expect(r.recallsTriggered).toBe(1);
    expect(r.conversionRate).toBe(0.5);
  });

  it('computeConversionRollup ignores recalls in other sessions and hints with no memory', async () => {
    await telemetry.logHintEmission({ sessionId: 's', form: 'form3', suggestedMemoryIds: ['m1'] });
    await telemetry.logHintEmission({ sessionId: 's', form: 'knowledge', suggestedMemoryIds: [] });
    await telemetry.logRecallCall({ sessionId: 'other', chunksReturned: 1, memoryIds: ['m1'] });
    const r = await telemetry.computeConversionRollup();
    expect(r).toEqual({ hintsEmitted: 1, recallsTriggered: 0, conversionRate: 0 });
  });
});
