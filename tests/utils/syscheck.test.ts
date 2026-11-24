import { describe, it, expect } from 'vitest';
import { evaluateSys } from '../../src/utils/syscheck.js';
import type { SysInfo } from '../../src/utils/syscheck.js';

function makeSysInfo(overrides: Partial<SysInfo> = {}): SysInfo {
  return {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'Apple M4 Pro',
    totalRamGB: 16,
    freeRamGB: 4,
    freeDiskGB: 50,
    nodeVersion: 'v20.0.0',
    isAppleSilicon: true,
    appleChipGen: 'M4 Pro',
    ...overrides,
  };
}

describe('evaluateSys — passing machines', () => {
  it('passes a healthy M4 MacBook', () => {
    const result = evaluateSys(makeSysInfo());
    expect(result.passes).toBe(true);
    expect(result.hardFail).toBe(false);
    expect(result.failReasons).toHaveLength(0);
  });

  it('passes a healthy Linux workstation', () => {
    const result = evaluateSys(makeSysInfo({
      platform: 'linux',
      arch: 'x86_64',
      cpuModel: 'Intel Core i9-14900K',
      isAppleSilicon: false,
      appleChipGen: null,
      totalRamGB: 32,
    }));
    expect(result.passes).toBe(true);
    expect(result.hardFail).toBe(false);
  });

  it('warns but passes with 6GB RAM (between fail and warn threshold)', () => {
    const result = evaluateSys(makeSysInfo({ totalRamGB: 6 }));
    expect(result.passes).toBe(true);
    expect(result.hardFail).toBe(false);
    expect(result.warnReasons.length).toBeGreaterThan(0);
  });
});

describe('evaluateSys — failing machines', () => {
  it('hard-fails with < 4GB RAM', () => {
    const result = evaluateSys(makeSysInfo({ totalRamGB: 2 }));
    expect(result.passes).toBe(false);
    expect(result.hardFail).toBe(true);
    expect(result.failReasons.some(r => r.includes('RAM'))).toBe(true);
  });

  it('hard-fails with < 3GB free disk', () => {
    const result = evaluateSys(makeSysInfo({ freeDiskGB: 1.5 }));
    expect(result.passes).toBe(false);
    expect(result.hardFail).toBe(true);
    expect(result.failReasons.some(r => r.includes('disk'))).toBe(true);
  });

  it('hard-fails on Windows', () => {
    const result = evaluateSys(makeSysInfo({ platform: 'win32' }));
    expect(result.passes).toBe(false);
    expect(result.hardFail).toBe(true);
    expect(result.failReasons.some(r => r.includes('windows'))).toBe(true);
  });

  it('hard-fails when both RAM and disk are under threshold', () => {
    const result = evaluateSys(makeSysInfo({ totalRamGB: 2, freeDiskGB: 1 }));
    expect(result.hardFail).toBe(true);
    expect(result.failReasons).toHaveLength(2);
  });
});

describe('evaluateSys — Apple Silicon detection', () => {
  it('detects M4 Pro chip gen', () => {
    const result = evaluateSys(makeSysInfo({ appleChipGen: 'M4 Pro' }));
    expect(result.info.appleChipGen).toBe('M4 Pro');
    expect(result.info.isAppleSilicon).toBe(true);
  });

  it('non-Apple machine has null chip gen', () => {
    const result = evaluateSys(makeSysInfo({
      platform: 'linux',
      isAppleSilicon: false,
      appleChipGen: null,
    }));
    expect(result.info.appleChipGen).toBeNull();
  });
});
