import { isAutoFocus, isAutoMode, type AutoFocus, type AutoMode } from '../router/focus.ts';

export interface SettingsStore {
  load(key: string): string | undefined;
  save(key: string, value: string): void;
}

const CACHE_MS = 30_000;

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

  setAutoMode(mode: string) {
    if (!isAutoMode(mode)) throw new Error(`Unknown mode: ${mode}. Use fallback or race`);
    this.write('auto.mode', mode);
  }
}
