// Usage governor. The synthesis job shares the Claude subscription with the user's
// own sessions and his other scheduled jobs (canvass, Upwork), so every model
// call is metered: per-run and per-day call/token caps, a wall-clock time box,
// and exponential-ish backoff after a rate/usage-limit response. When any limit
// trips, the run stops gracefully; work resumes at the next heartbeat.

import * as jobs from '../store/db/jobs.js';
import type { KnowledgeConfig } from '../types.js';
import type { Synthesizer, SynthRequest, SynthResponse } from './synth.js';
import { SynthRateLimitError } from './synth.js';

export const USAGE_JOB = 'synth-usage';
export const BACKOFF_BASE_MS = 30 * 60_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60_000;

export type StopReason = 'budget-run' | 'budget-day' | 'time-box' | 'rate-limit' | 'backoff';

export class BudgetStop extends Error {
  constructor(public readonly reason: StopReason, message?: string) {
    super(message ?? reason);
    this.name = 'BudgetStop';
  }
}

interface UsageStats {
  day: string;
  callsToday: number;
  tokensToday: number;
  consecutiveRateLimits: number;
}

const today = (now: Date) => now.toISOString().slice(0, 10);

export class UsageGovernor {
  runCalls = 0;
  runTokens = 0;
  readonly startedAt: number;

  constructor(
    private readonly cfg: KnowledgeConfig['synth'],
    private usage: UsageStats,
    private backoffUntil: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  static async load(cfg: KnowledgeConfig['synth'], now: () => number = Date.now): Promise<UsageGovernor> {
    const j = await jobs.getJob(USAGE_JOB, '');
    let stats: UsageStats = { day: today(new Date(now())), callsToday: 0, tokensToday: 0, consecutiveRateLimits: 0 };
    if (j?.stats) { try { stats = { ...stats, ...JSON.parse(j.stats) }; } catch { /* fresh */ } }
    if (stats.day !== today(new Date(now()))) stats = { ...stats, day: today(new Date(now())), callsToday: 0, tokensToday: 0 };
    const until = j?.watermark ? Date.parse(j.watermark) : 0;
    return new UsageGovernor(cfg, stats, Number.isNaN(until) ? 0 : until, now);
  }

  /**
   * Throws BudgetStop when the next call must not happen; otherwise RESERVES the call.
   * Reserving here (not when the reply arrives) keeps the per-run/per-day caps exact
   * when several calls are in flight at once.
   */
  check(): void {
    const t = this.now();
    if (t < this.backoffUntil) throw new BudgetStop('backoff', `rate-limit backoff until ${new Date(this.backoffUntil).toISOString()}`);
    if (t - this.startedAt > this.cfg.timeBoxMinutes * 60_000) throw new BudgetStop('time-box');
    if (this.runCalls >= this.cfg.maxCallsPerRun || this.runTokens >= this.cfg.maxTokensPerRun) throw new BudgetStop('budget-run');
    if (this.usage.callsToday >= this.cfg.maxCallsPerDay) throw new BudgetStop('budget-day');
    this.runCalls++;
    this.usage.callsToday++;
  }

  /** Account tokens for a finished call (the call itself was reserved in check()). */
  record(res: SynthResponse): void {
    const tokens = res.inputTokens + res.outputTokens;
    this.runTokens += tokens;
    this.usage.tokensToday += tokens;
    this.usage.consecutiveRateLimits = 0;
  }

  noteRateLimit(retryAfterMs: number): number {
    this.usage.consecutiveRateLimits++;
    const backoff = Math.min(BACKOFF_MAX_MS, Math.max(retryAfterMs, BACKOFF_BASE_MS * 2 ** (this.usage.consecutiveRateLimits - 1)));
    this.backoffUntil = this.now() + backoff;
    return backoff;
  }

  async persist(): Promise<void> {
    await jobs.recordStats(USAGE_JOB, '', { ...this.usage });
    await jobs.setWatermark(USAGE_JOB, '', new Date(this.backoffUntil || 0).toISOString());
  }

  snapshot() {
    return { runCalls: this.runCalls, runTokens: this.runTokens, callsToday: this.usage.callsToday, tokensToday: this.usage.tokensToday };
  }
}

/** Wraps any Synthesizer so every call is checked against and recorded in the governor. */
export class GovernedSynthesizer implements Synthesizer {
  readonly name: string;
  constructor(private readonly inner: Synthesizer, private readonly gov: UsageGovernor) {
    this.name = `governed(${inner.name})`;
  }

  async complete(req: SynthRequest): Promise<SynthResponse> {
    this.gov.check();
    try {
      const res = await this.inner.complete(req);
      this.gov.record(res);
      return res;
    } catch (err) {
      if (err instanceof SynthRateLimitError) {
        const ms = this.gov.noteRateLimit(err.retryAfterMs);
        await this.gov.persist();
        throw new BudgetStop('rate-limit', `rate limited; backing off ${Math.round(ms / 60000)} min`);
      }
      throw err;
    }
  }
}
