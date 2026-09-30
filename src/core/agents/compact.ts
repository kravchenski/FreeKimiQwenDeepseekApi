import type { ChatMessage } from '../providers/provider.ts';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const IMPORTANT = /error|warn|fail|panic|exception|traceback|denied|not found|cannot|fatal|abort|✗|×/i;
const MIN_LENGTH = 400;
const RECENT_RESULTS = 2;
const RECENT_LIMITS = { head: 150, tail: 100, important: 60 };
const OLDER_LIMITS = { head: 60, tail: 40, important: 30 };

export interface CompactionStats {
  results: number;
  charsBefore: number;
  charsAfter: number;
}

function repeated(line: string, count: number) {
  return count > 1 && line !== '' ? `${line} (×${count})` : line;
}

export function compactOutput(text: string, limits = RECENT_LIMITS) {
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .map(line => (line.includes('\r') ? line.split('\r').filter(Boolean).at(-1) ?? '' : line).replace(/\s+$/, ''));
  const collapsed: string[] = [];
  let previous: string | undefined;
  let count = 0;
  for (const line of lines) {
    if (line === previous) {
      count++;
      continue;
    }
    if (previous !== undefined) collapsed.push(repeated(previous, count));
    previous = line;
    count = 1;
  }
  if (previous !== undefined) collapsed.push(repeated(previous, count));
  const tidy = collapsed.filter((line, index) => line !== '' || (index > 0 && collapsed[index - 1] !== ''));
  if (tidy.length <= limits.head + limits.tail) return tidy.join('\n').trim();
  const middle = tidy.slice(limits.head, tidy.length - limits.tail);
  const kept = middle.filter(line => IMPORTANT.test(line)).slice(0, limits.important);
  const omitted = middle.length - kept.length;
  return [
    ...tidy.slice(0, limits.head),
    `… ${omitted} lines omitted by the gateway${kept.length ? `; ${kept.length} lines with errors or warnings kept below` : ''} …`,
    ...kept,
    ...(kept.length ? ['…'] : []),
    ...tidy.slice(tidy.length - limits.tail),
  ].join('\n').trim();
}

export function compactToolResults(messages: ChatMessage[]): { messages: ChatMessage[]; stats: CompactionStats } {
  const toolIndexes = messages.flatMap((message, index) => (message.role === 'tool' && typeof message.content === 'string' ? [index] : []));
  const recent = new Set(toolIndexes.slice(-RECENT_RESULTS));
  const stats: CompactionStats = { results: 0, charsBefore: 0, charsAfter: 0 };
  const compacted = messages.map((message, index) => {
    if (!toolIndexes.includes(index) || message.content.length < MIN_LENGTH) return message;
    const content = compactOutput(message.content, recent.has(index) ? RECENT_LIMITS : OLDER_LIMITS);
    if (content.length >= message.content.length) return message;
    stats.results++;
    stats.charsBefore += message.content.length;
    stats.charsAfter += content.length;
    return { ...message, content };
  });
  return { messages: compacted, stats };
}
