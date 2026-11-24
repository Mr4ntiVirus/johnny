// Single source of truth for Johnny's color palette.
// Terminal: chalk hex constants. Web (future): generate CSS variables from the same hex values.
import chalk from 'chalk';

export const neon = {
  cyan:    chalk.hex('#00FFE0'),
  magenta: chalk.hex('#FF2EA6'),
  green:   chalk.hex('#00FF66'),
  amber:   chalk.hex('#FFB000'),
  red:     chalk.hex('#FF3860'),
  matrix:  chalk.hex('#00FF41'),
};

export const ink = {
  fg:   chalk.hex('#D8E4FF'),
  grid: chalk.hex('#1A1F2C'),
};

// Dim variants (for dormant nodes, secondary metadata)
export const dim = {
  cyan:    chalk.hex('#00FFE0').dim,
  magenta: chalk.hex('#FF2EA6').dim,
  fg:      chalk.hex('#D8E4FF').dim,
};
