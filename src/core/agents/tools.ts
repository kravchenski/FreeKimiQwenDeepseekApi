import type { DecisionAnswer, DecisionQuestion } from '../decisions/engine.ts';
import type { ChatMessage } from '../providers/provider.ts';

export const TOOL_SELECTION_THRESHOLD = 15;
const KEEP_PROBABILITY = 0.35;
const QUESTIONS_PER_REQUEST = 60;
const CACHE_SIZE = 200;
const CORE_TOOLS = /^(?:read|write|edit|multiedit|bash|shell|local_shell|exec_command|write_stdin|apply_patch|glob|grep|ls|list|find|view|str_replace_based_edit_tool|todowrite|todo_write|update_plan|task|agent)$/i;

export type Tool = Record<string, any>;

export interface ToolSelection {
  tools: Tool[];
  before: number;
  after: number;
  dropped: string[];
  cached?: boolean;
}

export function toolName(tool: Tool): string {
  return String(tool?.function?.name ?? tool?.name ?? '');
}

function toolDescription(tool: Tool): string {
  return String(tool?.function?.description ?? tool?.description ?? '').replace(/\s+/g, ' ').slice(0, 300);
}

export function usedToolNames(messages: ChatMessage[]) {
  const names = new Set<string>();
  for (const message of messages) {
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = call?.function?.name ?? call?.name;
      if (typeof name === 'string') names.add(name);
    }
    if (message.role === 'tool' && typeof message.name === 'string') names.add(message.name);
  }
  return names;
}

function lastUserText(messages: ChatMessage[]) {
  const last = [...messages].reverse().find(message => message.role === 'user');
  const content = last?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n') : '';
}

export type ToolJudge = (request: string, questions: Record<string, DecisionQuestion>) => Promise<Record<string, DecisionAnswer>>;

export class ToolSelector {
  private readonly cache = new Map<string, Set<string>>();

  constructor(private readonly judge: ToolJudge) {}

  async select(tools: Tool[], messages: ChatMessage[]): Promise<ToolSelection> {
    const unchanged = { tools, before: tools.length, after: tools.length, dropped: [] };
    if (tools.length <= TOOL_SELECTION_THRESHOLD) return unchanged;
    const used = usedToolNames(messages);
    const optional = tools.filter(tool => !CORE_TOOLS.test(toolName(tool)) && !used.has(toolName(tool)));
    if (!optional.length) return unchanged;
    const request = lastUserText(messages);
    const key = `${request}\u0000${tools.map(toolName).join(',')}`;
    let wanted = this.cache.get(key);
    const cached = Boolean(wanted);
    if (!wanted) {
      wanted = await this.ask(request, optional);
      this.cache.set(key, wanted);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    }
    const kept = tools.filter(tool => !optional.includes(tool) || wanted!.has(toolName(tool)));
    return {
      tools: kept,
      before: tools.length,
      after: kept.length,
      dropped: optional.filter(tool => !wanted!.has(toolName(tool))).map(toolName),
      ...(cached ? { cached } : {}),
    };
  }

  private async ask(request: string, optional: Tool[]) {
    const wanted = new Set<string>();
    const batches: Tool[][] = [];
    for (let index = 0; index < optional.length; index += QUESTIONS_PER_REQUEST) batches.push(optional.slice(index, index + QUESTIONS_PER_REQUEST));
    await Promise.all(batches.map(async batch => {
      const questions: Record<string, DecisionQuestion> = {};
      batch.forEach((tool, index) => {
        questions[`tool_${index}`] = {
          type: 'noul',
          instructions: `Could the assistant need the tool '${toolName(tool)}' to carry out the user's request? It is described as: ${toolDescription(tool) || 'no description'}`,
        };
      });
      const answers = await this.judge(request, questions);
      batch.forEach((tool, index) => {
        const answer = answers[`tool_${index}`];
        const yes = answer && 'noul' in answer ? answer.noul : undefined;
        if (yes === undefined || yes >= KEEP_PROBABILITY) wanted.add(toolName(tool));
      });
    }));
    return wanted;
  }
}
