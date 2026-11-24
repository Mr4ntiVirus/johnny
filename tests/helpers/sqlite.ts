// Fresh in-memory SQLite store per test, without seeding the state row.
import { beforeEach, afterAll } from 'vitest';
import { setDatabasePath, closeDatabase } from '../../src/store/database.js';

export function useLocalSqlite(): void {
  beforeEach(() => {
    closeDatabase();
    setDatabasePath(':memory:');
  });
  afterAll(() => { closeDatabase(); });
}
