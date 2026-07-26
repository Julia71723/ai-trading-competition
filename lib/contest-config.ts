import type { ContestConfig } from './types';
import rawConfig from '../contest.config.json';

/** Typed, validated contest configuration loaded from contest.config.json. */
export function getContestConfig(): ContestConfig {
  const config = rawConfig as ContestConfig;
  if (!config.contestName) throw new Error('contest.config.json: missing contestName');
  if (!config.officialPurchaseTimestamp) throw new Error('contest.config.json: missing officialPurchaseTimestamp');
  if (!config.endTimestamp) throw new Error('contest.config.json: missing endTimestamp');
  if (!config.startingValue) throw new Error('contest.config.json: missing startingValue');
  if (!config.benchmarkSymbol) throw new Error('contest.config.json: missing benchmarkSymbol');
  if (!config.startPrices) throw new Error('contest.config.json: missing startPrices');
  return config;
}

/** The official contest start as a Date object. */
export function getContestStart(config: ContestConfig): Date {
  return new Date(config.officialPurchaseTimestamp);
}

/** The official contest end as a Date object. */
export function getContestEnd(config: ContestConfig): Date {
  return new Date(config.endTimestamp);
}

/** ISO date string (YYYY-MM-DD) of the contest start. */
export function getStartDateStr(config: ContestConfig): string {
  return new Date(config.officialPurchaseTimestamp).toISOString().split('T')[0];
}
