import type { Database } from 'bun:sqlite';
import crypto from 'node:crypto';

import type { ChatMessage } from '../providers/provider.ts';

const DEFAULT_TTL_MS = 24 * 60 * 60_000;

export interface PinnedRoute {
  provider: string;
  model: string;
}

function text(content: unknown) {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

export function conversationKey(messages: ChatMessage[]) {
  const system = messages.filter(message => message?.role === 'system').map(message => text(message.content));
  const firstUser = messages.find(message => message?.role === 'user');
  if (!firstUser) return undefined;
  return crypto.createHash('sha256').update(JSON.stringify([system, text(firstUser.content)])).digest('hex').slice(0, 32);
}

export class SessionAffinity {
  constructor(
    private readonly db: Database,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(conversationId: string, requestedModel: string): PinnedRoute | undefined {
    const row = this.db.query(`SELECT provider, model, updated_at AS updatedAt FROM conversation_routes
      WHERE conversation_id = $id AND requested_model = $requested`).get({ id: conversationId, requested: requestedModel }) as
      (PinnedRoute & { updatedAt: number }) | null;
    if (!row || row.updatedAt + this.ttlMs <= this.now()) return undefined;
    return { provider: row.provider, model: row.model };
  }

  set(conversationId: string, requestedModel: string, route: PinnedRoute) {
    this.db.query(`INSERT INTO conversation_routes (conversation_id, requested_model, provider, model, updated_at)
      VALUES ($id, $requested, $provider, $model, $now)
      ON CONFLICT (conversation_id) DO UPDATE SET requested_model = $requested, provider = $provider, model = $model, updated_at = $now`)
      .run({ id: conversationId, requested: requestedModel, provider: route.provider, model: route.model, now: this.now() });
  }

  prune() {
    return this.db.query('DELETE FROM conversation_routes WHERE updated_at <= $cutoff').run({ cutoff: this.now() - this.ttlMs }).changes;
  }
}
