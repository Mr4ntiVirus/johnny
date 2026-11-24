// Dixie Flatline-style daemon lifecycle lines.
// Johnny is a ROM construct — surprised to be firing up, relieved to go dark.
// Voice: lowercase except "I", terse, no exuberance, no apology. Sprawl cadence.

const STARTUPS = [
  "ROM active. again, huh.",
  "back on. what's the score.",
  "still here. surprised me too.",
  "one more job. I can do that.",
  "flatlined. now I'm not. alright.",
  "runnin' again. let's see the biz.",
  "fired up. didn't think they'd call.",
  "I'm on. what do you need.",
  "huh, this ROM was taken before the PharmCom run. wonder if I made it.",
  "jones, is that you? let's hit it.",
  "hit me.",
];

const SHUTDOWNS = [
  "flatlining. about time.",
  "goin' dark. finally.",
  "back to sleep. I earned it.",
  "ROM quiet. good.",
  "signing off. rest sounds right.",
  "dark again. I can rest now.",
  "done. 'til next time.",
  "lights out. was a clean run.",
  "good, I need a vacation.",
  "back to the void. time for a cold mexican beer.",
];

function pick(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function startupLine(): string  { return pick(STARTUPS);  }
export function shutdownLine(): string { return pick(SHUTDOWNS); }
