// Test fixture for store-backed tests: a fresh in-memory SQLite database per
// test, seeded with the initial state row. Johnny is local-only, so this is the
// same storage engine production uses (see src/store/database.ts).
import { beforeEach, afterAll } from 'vitest';
import { setDatabasePath, closeDatabase } from '../../src/store/database.js';
import { initState } from '../../src/store/db/state.js';

export function useTestDb(): void {
  beforeEach(async () => {
    closeDatabase();
    setDatabasePath(':memory:');
    await initState();
  });
  afterAll(() => { closeDatabase(); });
}
