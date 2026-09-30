import { describe, expect, test } from 'bun:test';

import { compactOutput, compactToolResults } from '../src/core/agents/compact.ts';
import { GatewaySettings } from '../src/core/settings/gateway-settings.ts';

describe('tool output compaction', () => {
  test('strips colours and progress redraws and collapses repeated and blank lines', () => {
    const raw = '\x1b[32mCompiling\x1b[0m app\nDownloading 10%\rDownloading 50%\rDownloading 100%\nok\nok\nok\n\n\n\ndone';
    expect(compactOutput(raw)).toBe('Compiling app\nDownloading 100%\nok (×3)\n\ndone');
  });

  test('keeps the start, the end and errors from the middle of long output', () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
    lines[500] = 'error[E0308]: mismatched types';
    const compacted = compactOutput(lines.join('\n'), { head: 5, tail: 5, important: 10 }).split('\n');
    expect(compacted.slice(0, 5)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
    expect(compacted[5]).toBe('… 989 lines omitted by the gateway; 1 lines with errors or warnings kept below …');
    expect(compacted[6]).toBe('error[E0308]: mismatched types');
    expect(compacted.slice(-5)).toEqual(['line 995', 'line 996', 'line 997', 'line 998', 'line 999']);
  });

  test('compacts only tool results, gives the latest ones more room and reports the saving', () => {
    const long = Array.from({ length: 400 }, (_, index) => `row ${index}`).join('\n');
    const messages = [
      { role: 'user', content: long },
      { role: 'tool', tool_call_id: 'a', content: long },
      { role: 'tool', tool_call_id: 'b', content: long },
      { role: 'tool', tool_call_id: 'c', content: long },
      { role: 'tool', tool_call_id: 'd', content: 'short' },
    ];
    const { messages: compacted, stats } = compactToolResults(messages);
    expect(compacted[0]).toBe(messages[0]);
    expect(compacted[4]).toBe(messages[4]);
    const lines = (index: number) => (compacted[index]!.content as string).split('\n').length;
    expect(lines(1)).toBe(101);
    expect(lines(3)).toBe(251);
    expect(stats.results).toBe(3);
    expect(stats.charsAfter).toBeLessThan(stats.charsBefore);
  });

  test('is on by default and can be turned off', () => {
    const store = new Map<string, string>();
    const settings = new GatewaySettings({ load: key => store.get(key), save: (key, value) => { store.set(key, value); } });
    expect(settings.agentOption('compact')).toBeTrue();
    settings.setAgentOption('compact', 'off');
    expect(settings.agentOption('compact')).toBeFalse();
    expect(() => settings.setAgentOption('compact', 'maybe')).toThrow('on or off');
    expect(() => settings.setAgentOption('teleport', 'on')).toThrow('Unknown agent option');
  });
});
