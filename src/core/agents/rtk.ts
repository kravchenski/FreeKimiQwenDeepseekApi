const SHELL_TOOLS = /^(?:bash|shell|local_shell|exec_command|run_shell_command|terminal)$/i;
const TIMEOUT_MS = 1_000;

export type Rewriter = (command: string) => string | undefined;

export interface RtkRewrite {
  from: string;
  to: string;
}

let located: string | null | undefined;

export function rtkPath() {
  if (located === undefined) located = Bun.which('rtk');
  return located;
}

export function rtkRewriter(binary = rtkPath()): Rewriter | undefined {
  if (!binary) return undefined;
  return command => {
    const result = Bun.spawnSync([binary, 'rewrite', command], { stdout: 'pipe', stderr: 'ignore', timeout: TIMEOUT_MS });
    const rewritten = result.stdout.toString().trim().split('\n').at(-1)?.trim() ?? '';
    return rewritten && rewritten !== command ? rewritten : undefined;
  };
}

function rewriteArguments(args: Record<string, unknown>, rewrite: Rewriter, changes: RtkRewrite[]) {
  const apply = (command: string) => {
    const to = rewrite(command);
    if (!to) return command;
    changes.push({ from: command, to });
    return to;
  };
  if (typeof args.command === 'string') return { ...args, command: apply(args.command) };
  if (typeof args.cmd === 'string') return { ...args, cmd: apply(args.cmd) };
  if (Array.isArray(args.command) && args.command.length >= 3 && /^(?:ba|z)?sh$/.test(String(args.command[0])) && /^-l?c$/.test(String(args.command[1]))) {
    const command = [...args.command];
    command[2] = apply(String(command[2]));
    return { ...args, command };
  }
  return args;
}

export function rewriteShellCalls<T extends Record<string, any>>(toolCalls: T[], rewrite: Rewriter): { toolCalls: T[]; changes: RtkRewrite[] } {
  const changes: RtkRewrite[] = [];
  const rewritten = toolCalls.map(call => {
    const name = call?.function?.name;
    if (typeof name !== 'string' || !SHELL_TOOLS.test(name)) return call;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return call;
    }
    if (!args || typeof args !== 'object') return call;
    const next = rewriteArguments(args as Record<string, unknown>, rewrite, changes);
    return next === args ? call : { ...call, function: { ...call.function, arguments: JSON.stringify(next) } };
  });
  return { toolCalls: rewritten, changes };
}
