// Thin wrapper over db/state.ts and db/sessions.ts.

import type { JohnnyState } from '../types.js';
import {
  getTurnCounter as dbGetGlobalTurn,
  incrementTurn as dbIncrementGlobalTurn,
  getRankUpdatedTurn as dbGetRankUpdatedTurn,
  setRankUpdatedTurn as dbSetRankUpdatedTurn,
} from './db/state.js';
import { incrementSessionTurn, getSessionTurn } from './db/sessions.js';

export async function readState(): Promise<JohnnyState> {
  return {
    turnCounter: await dbGetGlobalTurn(),
    firstTurnAt: '',
    lastTurnAt: '',
  };
}

export async function incrementTurn(sessionId: string): Promise<number> {
  const [sessionTurn] = await Promise.all([
    incrementSessionTurn(sessionId),
    dbIncrementGlobalTurn(),
  ]);
  return sessionTurn;
}

export async function getSessionCurrentTurn(sessionId: string): Promise<number> {
  return getSessionTurn(sessionId);
}

export async function getRankUpdatedTurn(): Promise<number> {
  return dbGetRankUpdatedTurn();
}

export async function setRankUpdatedTurn(turn: number): Promise<void> {
  await dbSetRankUpdatedTurn(turn);
}
