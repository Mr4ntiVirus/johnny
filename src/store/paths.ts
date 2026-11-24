import * as os from 'node:os';
import * as path from 'node:path';

const JOHNNY_DIR = path.join(os.homedir(), '.johnny');

export const PATHS = {
  dir: JOHNNY_DIR,
  database: path.join(JOHNNY_DIR, 'johnny.db'),
  config: path.join(JOHNNY_DIR, 'config.json'),
  log: path.join(JOHNNY_DIR, 'johnny.log'),
  disabled: path.join(JOHNNY_DIR, 'disabled'),
  daemonPid: path.join(JOHNNY_DIR, 'daemon.pid'),
  dbSock: path.join(JOHNNY_DIR, 'db.sock'),
  lastRecall: path.join(JOHNNY_DIR, 'last-recall.json'),
} as const;
