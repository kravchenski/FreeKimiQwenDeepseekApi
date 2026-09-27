export interface ChainCandidate {
  id: string;
  provider: string;
}

const WEB_CHATS = [
  { provider: 'qwen', pick: (ids: string[]) => ids.includes('qwen3.7-plus') ? 'qwen3.7-plus' : ids.find(id => /^qwen\d/.test(id)) },
  { provider: 'deepseek', pick: (ids: string[]) => ids.find(id => id === 'deepseek-default') },
  { provider: 'glm-chat', pick: (ids: string[]) => ids.find(id => id === 'glm-chat') },
  { provider: 'kimi-chat', pick: (ids: string[]) => ids.find(id => id === 'kimi-chat') },
];

const NVIDIA_FAMILIES = [
  /^deepseek-ai\//,
  /^moonshotai\//,
  /^z-ai\//,
  /^qwen\//,
  /^nvidia\/.*nemotron/,
  /^meta\//,
  /^mistralai\//,
];

export const MAX_FALLBACK_MODELS = 8;
const MAX_PER_FAMILY = 2;

function family(model: string) {
  const index = NVIDIA_FAMILIES.findIndex(pattern => pattern.test(model));
  return index === -1 ? NVIDIA_FAMILIES.length : index;
}

export function buildAutoChain(candidates: ChainCandidate[], isAvailable: (model: string) => boolean = () => true) {
  const usable = candidates.filter(candidate => isAvailable(candidate.id));
  const idsOf = (provider: string) => usable.filter(candidate => candidate.provider === provider).map(candidate => candidate.id);
  const web = WEB_CHATS.flatMap(chat => {
    const model = chat.pick(idsOf(chat.provider));
    return model ? [model] : [];
  });
  const perFamily = new Map<number, number>();
  const fallback = idsOf('nvidia')
    .map(id => ({ id, family: family(id) }))
    .sort((a, b) => a.family - b.family || b.id.localeCompare(a.id, 'en', { numeric: true }))
    .filter(entry => {
      const count = perFamily.get(entry.family) ?? 0;
      perFamily.set(entry.family, count + 1);
      return count < MAX_PER_FAMILY;
    })
    .slice(0, MAX_FALLBACK_MODELS)
    .map(entry => entry.id);
  return [...web, ...fallback];
}
