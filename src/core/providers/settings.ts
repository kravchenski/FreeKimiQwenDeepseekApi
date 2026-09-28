export interface ProviderSetting {
  provider: string;
  auto: boolean;
  updatedAt: number;
}

export interface ProviderSettingsStore {
  load(provider: string): ProviderSetting | undefined;
  save(setting: ProviderSetting): void;
}

const CACHE_MS = 30_000;

export class ProviderSettings {
  private readonly cache = new Map<string, { setting?: ProviderSetting; readAt: number }>();

  constructor(
    private readonly store: ProviderSettingsStore,
    private readonly now: () => number = Date.now,
  ) {}

  autoEnabled(provider: string) {
    const cached = this.cache.get(provider);
    if (cached && this.now() - cached.readAt < CACHE_MS) return cached.setting?.auto ?? true;
    let setting: ProviderSetting | undefined;
    try {
      setting = this.store.load(provider);
    } catch {}
    this.cache.set(provider, { setting, readAt: this.now() });
    return setting?.auto ?? true;
  }

  setAuto(provider: string, auto: boolean) {
    const setting = { provider, auto, updatedAt: this.now() };
    this.store.save(setting);
    this.cache.set(provider, { setting, readAt: this.now() });
    return setting;
  }
}
