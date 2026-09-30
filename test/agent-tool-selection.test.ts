import { describe, expect, test } from 'bun:test';

import { toolName, ToolSelector, usedToolNames, type ToolJudge } from '../src/core/agents/tools.ts';
import type { DecisionQuestion } from '../src/core/decisions/engine.ts';

const tool = (name: string, description = `${name} tool`) => ({ type: 'function', function: { name, description, parameters: { type: 'object' } } });
const core = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'].map(name => tool(name));
const extra = Array.from({ length: 14 }, (_, index) => tool(`mcp__service__action_${index}`));

function judge(keep: (name: string) => boolean): ToolJudge & { calls: Array<Record<string, DecisionQuestion>> } {
  const calls: Array<Record<string, DecisionQuestion>> = [];
  const fn = (async (_request: string, questions: Record<string, DecisionQuestion>) => {
    calls.push(questions);
    return Object.fromEntries(Object.entries(questions).map(([key, question]) => {
      const name = /tool '([^']+)'/.exec(question.instructions)![1]!;
      return [key, { noul: keep(name) ? 0.9 : 0.05, confidence: 0.9 }];
    }));
  }) as ToolJudge & { calls: Array<Record<string, DecisionQuestion>> };
  fn.calls = calls;
  return fn;
}

describe('tool selection', () => {
  test('leaves small tool lists alone', async () => {
    const selector = new ToolSelector(judge(() => false));
    const small = [...core, ...extra.slice(0, 5)];
    expect(await selector.select(small, [{ role: 'user', content: 'fix it' }])).toEqual({ tools: small, before: 11, after: 11, dropped: [] });
  });

  test('keeps core and already used tools, asks about the rest and caches the answer per task', async () => {
    const decide = judge(name => name.endsWith('_3'));
    const selector = new ToolSelector(decide);
    const messages = [
      { role: 'user', content: 'open an issue for this bug' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'mcp__service__action_7', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'done' },
    ];
    const tools = [...core, ...extra];
    const selection = await selector.select(tools, messages);
    expect(selection.tools.map(toolName)).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'mcp__service__action_3', 'mcp__service__action_7']);
    expect(selection).toMatchObject({ before: 20, after: 8 });
    expect(selection.dropped).toHaveLength(12);
    expect(Object.keys(decide.calls[0]!)).toHaveLength(13);
    const again = await selector.select(tools, [...messages, { role: 'assistant', content: 'next step' }]);
    expect(again.cached).toBeTrue();
    expect(decide.calls).toHaveLength(1);
  });

  test('keeps a tool the decision model did not answer about', async () => {
    const selector = new ToolSelector(async () => ({}));
    const selection = await selector.select([...core, ...extra], [{ role: 'user', content: 'x' }]);
    expect(selection.after).toBe(20);
  });

  test('reads tool names from calls in the history', () => {
    expect([...usedToolNames([{ role: 'assistant', tool_calls: [{ function: { name: 'Bash' } }] }, { role: 'tool', name: 'Read', content: '' }])]).toEqual(['Bash', 'Read']);
  });
});
