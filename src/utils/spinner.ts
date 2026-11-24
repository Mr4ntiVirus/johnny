import { neon, dim } from '../brand/tokens.js';

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private label = '';
  private out: NodeJS.WriteStream;

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out;
  }

  start(label: string): void {
    this.label = label;
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 80);
  }

  update(label: string): void {
    this.label = label;
  }

  private render(): void {
    this.out.write(`\r${neon.cyan(FRAMES[this.frame])} ${dim.fg(this.label)}\x1b[K`);
  }

  stop(glyph: string, label: string): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.out.write(`\r${glyph} ${label}\x1b[K\n`);
  }

  clear(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.out.write('\r\x1b[K');
  }
}
