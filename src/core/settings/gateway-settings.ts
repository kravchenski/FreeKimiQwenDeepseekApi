import { isAutoFocus, isAutoMode, type AutoFocus, type AutoMode } from '../router/focus.ts';

export interface SettingsStore {
  load(key: string): string | undefined;
  save(key: string, value: string): void;
}

const CACHE_MS = 30_000;

export const AGENT_OPTIONS = { compact: true, tools: true } as const;
export type AgentOption = keyof typeof AGENT_OPTIONS;

export function isAgentOption(value: string): value is AgentOption {
  return Object.hasOwn(AGENT_OPTIONS, value);
}

export class GatewaySettings {
  private readonly cache = new Map<string, { value?: string; readAt: number }>();

  constructor(
    private readonly store: SettingsStore,
    private readonly now: () => number = Date.now,
  ) {}

  private read(key: string) {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.readAt < CACHE_MS) return cached.value;
    let value: string | undefined;
    try {
      value = this.store.load(key);
    } catch {}
    this.cache.set(key, { value, readAt: this.now() });
    return value;
  }

  private write(key: string, value: string) {
    this.store.save(key, value);
    this.cache.set(key, { value, readAt: this.now() });
  }

  autoFocus(): AutoFocus {
    const value = this.read('auto.focus');
    return isAutoFocus(value) ? value : 'general';
  }

  autoMode(): AutoMode {
    const value = this.read('auto.mode');
    return isAutoMode(value) ? value : 'fallback';
  }

  setAutoFocus(focus: string) {
    if (!isAutoFocus(focus)) throw new Error(`Unknown focus: ${focus}. Use general, coding, reasoning or fast`);
    this.write('auto.focus', focus);
  }

  agentOption(name: AgentOption) {
    const value = this.read(`agents.${name}`);
    return value === 'on' ? true : value === 'off' ? false : AGENT_OPTIONS[name];
  }

  setAgentOption(name: string, value: string) {
    if (!isAgentOption(name)) throw new Error(`Unknown agent option: ${name}`);
    if (value !== 'on' && value !== 'off') throw new Error(`Use on or off for ${name}`);
    this.write(`agents.${name}`, value);
  }

  setAutoMode(mode: string) {
    if (!isAutoMode(mode)) throw new Error(`Unknown mode: ${mode}. Use fallback, race or decide`);
    this.write('auto.mode', mode);
  }
}
