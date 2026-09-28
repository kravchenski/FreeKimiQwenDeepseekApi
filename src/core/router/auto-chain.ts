import { rankModels, type ModelStats } from '../models/stats.ts';

export interface ChainCandidate {
  id: string;
  provider: string;
  fallback: boolean;
}

export const MAX_FALLBACK_MODELS = 8;

export function buildAutoChain(
  candidates: ChainCandidate[],
  stats: Pick<ModelStats, 'get'>,
  isAvailable: (model: string) => boolean = () => true,
  preference: (model: string) => number = () => 0,
) {
  const usable = candidates.filter(candidate => isAvailable(candidate.id));
  const primary = [...new Set(usable.filter(candidate => !candidate.fallback).map(candidate => candidate.provider))]
    .map(provider => rankModels(usable.filter(candidate => candidate.provider === provider).map(candidate => candidate.id), stats, preference)[0]!);
  const fallback = rankModels(usable.filter(candidate => candidate.fallback).map(candidate => candidate.id), stats, preference)
    .slice(0, MAX_FALLBACK_MODELS);
  return [...rankModels(primary, stats, preference), ...fallback];
}
