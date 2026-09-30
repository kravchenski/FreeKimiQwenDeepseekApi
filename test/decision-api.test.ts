import { describe, expect, test } from 'bun:test';

import { decide, decisionMessages, readDecisionAnswers, readDecisionRequest } from '../src/core/decisions/engine.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { DecisionLog } from '../src/core/router/decisions.ts';
import { promptOf, SmartRouter } from '../src/core/router/smart-router.ts';

const skillRequest = {
  model: 'jev-latest',
  state: { request: 'Make me a pptx deck', recent_context: '' },
  questions: {
    which: { type: 'choice', instructions: 'Which skill?', criteria: { pptx: 'PowerPoint files', docx: 'Word files' } },
    'gate::prose_suffices': { type: 'noul', instructions: 'Is prose enough?' },
    flag: { type: 'boolean', instructions: 'Is it a file task?' },
  },
};

describe('decision API', () => {
  test('reads a TypeSafe System One request and rejects broken ones', () => {
    expect(readDecisionRequest(skillRequest).questions.which!.criteria).toEqual({ pptx: 'PowerPoint files', docx: 'Word files' });
    expect(() => readDecisionRequest({ questions: {} })).toThrow('1 to 64');
    expect(() => readDecisionRequest({ questions: { a: { type: 'rank', instructions: 'x' } } })).toThrow('choice, noul or boolean');
    expect(() => readDecisionRequest({ questions: { a: { type: 'choice', instructions: 'x' } } })).toThrow('criteria');
  });

  test('asks for every key and option and turns the reply into System One answers', () => {
    const request = readDecisionRequest(skillRequest);
    const prompt = decisionMessages(request)[1]!.content as string;
    expect(prompt).toContain('request: Make me a pptx deck');
    expect(prompt).toContain('"which": {"probabilities": {"pptx": 0.0, "docx": 0.0}}');
    expect(prompt).not.toContain('…');
    const answers = readDecisionAnswers(request, 'Sure: {"which": {"probabilities": {"pptx": 3, "docx": 1}}, "gate::prose_suffices": {"yes": 0.1}, "flag": 0.8}');
    expect(answers).toEqual({
      which: { choice: 'pptx', confidence: 0.75, probabilities: { pptx: 0.75, docx: 0.25 } },
      'gate::prose_suffices': { noul: 0.1, confidence: 0.9 },
      flag: { boolean: true, probability: 0.8 },
    });
    expect(readDecisionAnswers(request, '{}').which).toEqual({ choice: 'pptx', confidence: 0.5, probabilities: { pptx: 0.5, docx: 0.5 } });
    expect(() => readDecisionAnswers(request, 'no json here')).toThrow('did not answer with JSON');
  });

  test('passes the reader to the completion so a bad answer can move on to another model', async () => {
    const request = readDecisionRequest(skillRequest);
    const replies = ['not json', '{"which": {"probabilities": {"docx": 1}}}'];
    const result = await decide(request, async (_messages, read) => {
      for (const reply of replies) {
        try {
          return read(reply);
        } catch {}
      }
      throw new Error('none');
    });
    expect(result.which).toMatchObject({ choice: 'docx' });
  });
});

function provider(id: string, seen: string[]): Provider {
  return {
    id,
    ownedBy: id,
    fallback: true,
    supports: model => model === `${id}-model`,
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request) {
      seen.push(request.model);
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: 'ok' }; })() };
    },
  };
}

describe('decide mode', () => {
  test('puts the route the decision model picks first and records it', async () => {
    const seen: string[] = [];
    const log = new DecisionLog();
    const prompts: string[] = [];
    const registry = new ProviderRegistry().register(provider('a', seen)).register(provider('b', seen));
    const router = new SmartRouter(registry, ['a-model', 'b-model'], Date.now, {
      autoMode: () => 'decide',
      choose: async (prompt, routes) => {
        prompts.push(`${prompt} | ${routes.map(route => route.model).join(',')}`);
        return 'b-model';
      },
      onDecision: decision => log.add(decision),
    });
    const opened = await router.open('auto', route => ({ model: route.model, messages: [{ role: 'user', content: 'fix my code' }] }));
    expect(opened.route.model).toBe('b-model');
    expect(prompts).toEqual(['fix my code | a-model,b-model']);
    expect(log.list()[0]).toMatchObject({ mode: 'decide', picked: 'b-model', chosen: { model: 'b-model' } });
  });

  test('keeps the chain order when the decision fails', async () => {
    const seen: string[] = [];
    const registry = new ProviderRegistry().register(provider('a', seen)).register(provider('b', seen));
    const router = new SmartRouter(registry, ['a-model', 'b-model'], Date.now, { autoMode: () => 'decide', choose: async () => { throw new Error('down'); } });
    expect((await router.open('auto', route => ({ model: route.model, messages: [] }))).route.model).toBe('a-model');
  });

  test('reads the latest user text from plain and multi-part messages', () => {
    expect(promptOf([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'x' }, { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image_url' }] }])).toBe('second\n');
    expect(promptOf([])).toBe('');
  });
});
