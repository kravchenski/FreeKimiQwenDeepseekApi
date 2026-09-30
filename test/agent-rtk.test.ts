import { describe, expect, test } from 'bun:test';

import { rewriteShellCalls, rtkPath, rtkRewriter } from '../src/core/agents/rtk.ts';

const call = (name: string, args: Record<string, unknown>) => ({ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const fake = (command: string) => (/^(?:git|ls|cat) /.test(command) ? `rtk ${command}` : undefined);

describe('rtk rewriting', () => {
  test('rewrites shell commands of Claude Code, Codex, pi and OpenCode', () => {
    const { toolCalls, changes } = rewriteShellCalls([
      call('Bash', { command: 'git status', description: 'status' }),
      call('shell', { command: ['bash', '-lc', 'ls -la src'] }),
      call('exec_command', { cmd: 'cat package.json' }),
      call('bash', { command: 'npm test' }),
      call('Read', { file_path: 'a.ts' }),
    ], fake);
    expect(toolCalls.map(entry => JSON.parse(entry.function.arguments))).toEqual([
      { command: 'rtk git status', description: 'status' },
      { command: ['bash', '-lc', 'rtk ls -la src'] },
      { cmd: 'rtk cat package.json' },
      { command: 'npm test' },
      { file_path: 'a.ts' },
    ]);
    expect(changes).toEqual([
      { from: 'git status', to: 'rtk git status' },
      { from: 'ls -la src', to: 'rtk ls -la src' },
      { from: 'cat package.json', to: 'rtk cat package.json' },
    ]);
  });

  test('leaves calls with broken arguments untouched', () => {
    const broken = { id: 'c', type: 'function', function: { name: 'Bash', arguments: '{not json' } };
    expect(rewriteShellCalls([broken], fake).toolCalls[0]).toBe(broken);
  });

  test('uses the installed rtk when there is one', () => {
    expect(rtkRewriter(null)).toBeUndefined();
    const rewrite = rtkRewriter();
    if (!rtkPath() || !rewrite) return;
    expect(rewrite('git status')).toBe('rtk git status');
    expect(rewrite('rtk git status')).toBeUndefined();
  });
});
