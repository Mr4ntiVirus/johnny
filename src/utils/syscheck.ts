// System requirements check and OS detection.
// Run before pulling models or bootstrap — don't waste time on a machine that can't keep up.
import * as os from 'node:os';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import { neon, ink, dim } from '../brand/tokens.js';

const w = (s: string) => process.stdout.write(s);

// ── Thresholds ────────────────────────────────────────────────────────────────

const RAM_FAIL_GB  = 4;   // below this → hard fail
const RAM_WARN_GB  = 8;   // below this → warn but continue
const DISK_FAIL_GB = 3;   // below this → hard fail (models + data)

// ── Types ─────────────────────────────────────────────────────────────────────

export type SupportedOS = 'darwin' | 'linux' | 'win32' | 'other';

export interface SysInfo {
  platform: SupportedOS;
  arch: string;
  cpuModel: string;
  totalRamGB: number;
  freeRamGB: number;
  freeDiskGB: number;
  nodeVersion: string;
  isAppleSilicon: boolean;
  appleChipGen: string | null;   // "M4 Pro", "M2", etc. — null if not Apple Silicon
}

export interface SysCheckResult {
  info: SysInfo;
  passes: boolean;
  hardFail: boolean;         // false = warn only; true = refuse to continue
  failReasons: string[];
  warnReasons: string[];
}

// ── Info collection ───────────────────────────────────────────────────────────

function parseAppleChip(cpuModel: string): string | null {
  // "Apple M4 Pro" → "M4 Pro", "Apple M1" → "M1"
  const m = cpuModel.match(/Apple (M\d+(?:\s+(?:Pro|Max|Ultra|Nano))?)/i);
  return m ? m[1] : null;
}

async function getFreeDiskGB(): Promise<number> {
  try {
    const platform = os.platform();
    if (platform === 'win32') {
      // wmic logicaldisk where "DeviceID='C:'" get FreeSpace
      const out = cp.execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /value', {
        encoding: 'utf-8', timeout: 5000,
      });
      const m = out.match(/FreeSpace=(\d+)/);
      return m ? parseInt(m[1], 10) / 1e9 : 0;
    } else {
      const out = cp.execSync(`df -k "${os.homedir()}"`, { encoding: 'utf-8', timeout: 5000 });
      const lines = out.trim().split('\n');
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      const freeKB = parseInt(parts[3] ?? '0', 10);
      return freeKB / (1024 * 1024);
    }
  } catch { return 999; /* unknown — assume fine */ }
}

export async function collectSysInfo(): Promise<SysInfo> {
  const platform = os.platform() as SupportedOS;
  const arch = os.arch();
  const cpuModel = os.cpus()[0]?.model ?? 'unknown';
  const totalRamGB = os.totalmem() / 1e9;
  const freeRamGB = os.freemem() / 1e9;
  const freeDiskGB = await getFreeDiskGB();
  const nodeVersion = process.version;
  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';
  const appleChipGen = isAppleSilicon ? parseAppleChip(cpuModel) : null;

  return {
    platform,
    arch,
    cpuModel,
    totalRamGB,
    freeRamGB,
    freeDiskGB,
    nodeVersion,
    isAppleSilicon,
    appleChipGen,
  };
}

// ── Evaluation ────────────────────────────────────────────────────────────────

export function evaluateSys(info: SysInfo): SysCheckResult {
  const failReasons: string[] = [];
  const warnReasons: string[] = [];

  if (info.totalRamGB < RAM_FAIL_GB) {
    failReasons.push(`${info.totalRamGB.toFixed(1)}GB RAM — need at least ${RAM_FAIL_GB}GB`);
  } else if (info.totalRamGB < RAM_WARN_GB) {
    warnReasons.push(`${info.totalRamGB.toFixed(1)}GB RAM — ${RAM_WARN_GB}GB recommended for smooth model loads`);
  }

  if (info.freeDiskGB < DISK_FAIL_GB) {
    failReasons.push(`${info.freeDiskGB.toFixed(1)}GB free disk — need at least ${DISK_FAIL_GB}GB for models`);
  }

  if (info.platform === 'win32') {
    failReasons.push('windows');
  }

  const hardFail = failReasons.length > 0;
  return { info, passes: !hardFail, hardFail, failReasons, warnReasons };
}

// ── Voice lines ───────────────────────────────────────────────────────────────

function passLine(info: SysInfo): string {
  const ram = Math.round(info.totalRamGB);

  if (info.appleChipGen) {
    const chip = info.appleChipGen;
    if (chip.includes('M4'))
      return `${chip} silicon. neural engine on tap. this deck was built for this.`;
    if (chip.includes('M3') || chip.includes('M2'))
      return `${chip} silicon. ${ram}GB RAM. the Sendai boys would be jealous.`;
    return `Apple silicon. ${ram}GB RAM. solid courier-grade wetware.`;
  }

  if (ram >= 64)
    return `${ram}GB RAM. I've never run this loaded. this deck's got capacity.`;
  if (ram >= 32)
    return `${ram}GB RAM. courier-grade wetware. let's load everything.`;
  if (ram >= 16)
    return `${ram}GB, clean disk. deck checks out. running hot.`;
  return `${ram}GB'll do. tight but I've run leaner. keep the gomi minimal.`;
}

const FAIL_LINE =
  "Gotta be honest with you, this deck is no Fairlight Excalibur. you need to upgrade. " +
  "how about a nice Ono Sendai Cyberspace VII, or even a MacBook M4. Come back when you got the goods.";

const WINDOWS_LINE =
  "windows, that's cute. I didn't know they still made that trash. get a linux system you script kiddie.";

// ── Display ───────────────────────────────────────────────────────────────────

export async function printSysCheck(): Promise<SysCheckResult> {
  const info = await collectSysInfo();
  const result = evaluateSys(info);

  // OS badge
  const osBadge: Record<string, string> = {
    darwin:  info.isAppleSilicon ? `macOS · ${info.appleChipGen ?? 'Apple Silicon'}` : 'macOS · Intel',
    linux:   'Linux',
    win32:   'Windows',
    other:   info.platform,
  };
  const badge = osBadge[info.platform] ?? info.platform;

  w(dim.fg(`  ── system check ────────────────────────\n`));
  w(dim.fg(`  OS      `) + ink.fg(badge) + '\n');
  w(dim.fg(`  arch    `) + ink.fg(info.arch) + '\n');
  w(dim.fg(`  RAM     `) + ink.fg(`${info.totalRamGB.toFixed(1)} GB total · ${info.freeRamGB.toFixed(1)} GB free`) + '\n');
  w(dim.fg(`  disk    `) + ink.fg(`${info.freeDiskGB.toFixed(1)} GB free`) + '\n');
  w(dim.fg(`  node    `) + ink.fg(info.nodeVersion) + '\n');
  w('\n');

  // Warnings
  for (const warn of result.warnReasons) {
    w(neon.amber(`  ↯ ${warn}\n`));
  }

  if (result.hardFail) {
    // Hard fail
    w('\n');
    if (info.platform === 'win32') {
      w(neon.red(`  "${WINDOWS_LINE}"\n`));
    } else {
      for (const reason of result.failReasons) {
        w(neon.red(`  × ${reason}\n`));
      }
      w('\n');
      w(neon.red(`  "${FAIL_LINE}"\n`));
    }
    w('\n');
  } else {
    // Pass
    w(neon.cyan(`  ◈ ${passLine(info)}\n`));
    w('\n');
  }

  return result;
}
