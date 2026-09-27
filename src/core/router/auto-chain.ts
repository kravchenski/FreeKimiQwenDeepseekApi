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
) {
  const usable = candidates.filter(candidate => isAvailable(candidate.id));
  const primary = [...new Set(usable.filter(candidate => !candidate.fallback).map(candidate => candidate.provider))]
    .map(provider => rankModels(usable.filter(candidate => candidate.provider === provider).map(candidate => candidate.id), stats)[0]!);
  const fallback = rankModels(usable.filter(candidate => candidate.fallback).map(candidate => candidate.id), stats)
    .slice(0, MAX_FALLBACK_MODELS);
  return [...rankModels(primary, stats), ...fallback];
}
