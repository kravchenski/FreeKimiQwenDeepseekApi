import type { Provider } from './provider.ts';

export interface ModelEntry {
  id: string;
  ownedBy: string;
}

export class ProviderRegistry {
  private readonly providers: Provider[] = [];

  register(provider: Provider) {
    if (this.providers.some(existing => existing.id === provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.providers.push(provider);
    return this;
  }

  resolve(model: string) {
    return this.providers.find(provider => provider.supports(model));
  }

  list(): readonly Provider[] {
    return this.providers;
  }

  async listModels(): Promise<ModelEntry[]> {
    const results = await Promise.allSettled(this.providers.map(provider => provider.listModels()));
    return results.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? result.value.map(id => ({ id, ownedBy: this.providers[index]!.ownedBy }))
        : []
    );
  }
}
