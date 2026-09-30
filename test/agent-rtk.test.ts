import { describe, expect, test } from 'bun:test';

import { restoreShellCalls, rewriteShellCalls, rtkPath, rtkRewriter } from '../src/core/agents/rtk.ts';

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

  test('shows the model its own commands again so it does not start writing rtk itself', () => {
    const { toolCalls } = rewriteShellCalls([call('Bash', { command: 'git log --oneline -3' }), call('shell', { command: ['bash', '-lc', 'ls src'] })], fake);
    const history = [
      { role: 'user', content: 'what changed?' },
      { role: 'assistant', content: null, tool_calls: toolCalls },
      { role: 'tool', tool_call_id: 'c', content: 'abc fix' },
      { role: 'assistant', content: null, tool_calls: [call('Bash', { command: 'rtk gain' })] },
    ];
    const { messages, restored } = restoreShellCalls(history);
    expect(restored).toBe(2);
    expect(JSON.parse(messages[1]!.tool_calls![0]!.function.arguments)).toEqual({ command: 'git log --oneline -3' });
    expect(JSON.parse(messages[1]!.tool_calls![1]!.function.arguments)).toEqual({ command: ['bash', '-lc', 'ls src'] });
    expect(messages[3]).toBe(history[3]);
    expect(messages[2]).toBe(history[2]);
  });

  test('leaves calls with broken arguments untouched', () => {
    const broken = { id: 'c', type: 'function', function: { name: 'Bash', arguments: '{not json' } };
    expect(rewriteShellCalls([broken], fake).toolCalls[0]).toBe(broken);
  });

  test('follows the rtk rewrite exit codes: 0 and 3 rewrite, 1 and 2 pass through', () => {
    const answers: Record<string, { exitCode: number; stdout: string }> = {
      'git status': { exitCode: 3, stdout: 'rtk git status\n' },
      ls: { exitCode: 0, stdout: 'rtk ls\n' },
      'rm -rf /': { exitCode: 2, stdout: 'rtk rm -rf /\n' },
      'npm test': { exitCode: 1, stdout: '' },
    };
    const rewrite = rtkRewriter('rtk', (_binary, command) => answers[command] ?? { exitCode: 1, stdout: '' })!;
    expect(rewrite('git status')).toBe('rtk git status');
    expect(rewrite('ls')).toBe('rtk ls');
    expect(rewrite('rm -rf /')).toBeUndefined();
    expect(rewrite('npm test')).toBeUndefined();
  });

  test('does not pass RTK_REWRITE_HOST on to rtk', () => {
    if (process.platform === 'win32' || !rtkPath()) return;
    process.env.RTK_REWRITE_HOST = 'openclaw';
    try {
      expect(rtkRewriter()!('git status')).toBe('rtk git status');
    } finally {
      delete process.env.RTK_REWRITE_HOST;
    }
  });

  test('uses the installed rtk when there is one', () => {
    expect(rtkRewriter(null)).toBeUndefined();
    const rewrite = rtkRewriter();
    if (!rtkPath() || !rewrite) return;
    expect(rewrite('git status')).toBe('rtk git status');
    expect(rewrite('rtk git status')).toBeUndefined();
  });
});
