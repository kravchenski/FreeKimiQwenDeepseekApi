import { ProviderError } from '../providers/errors.ts';
import type { ChatMessage } from '../providers/provider.ts';

export interface DecisionQuestion {
  type: 'choice' | 'noul' | 'boolean';
  instructions: string;
  criteria?: Record<string, string>;
}

export interface DecisionRequest {
  model?: string;
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  | { choice: string; confidence: number; probabilities: Record<string, number> }
  | { noul: number; confidence: number }
  | { boolean: boolean; probability: number };

const MAX_QUESTIONS = 64;
const MAX_OPTIONS = 256;
const MAX_TEXT = 4_000;

function invalid(message: string): never {
  throw new ProviderError(message, 'invalid_request', 400);
}

export function readDecisionRequest(body: unknown): DecisionRequest {
  if (!body || typeof body !== 'object') invalid('Body must be a JSON object');
  const { model, state, questions } = body as Record<string, unknown>;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) invalid('questions must be an object');
  const entries = Object.entries(questions as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_QUESTIONS) invalid(`questions must hold 1 to ${MAX_QUESTIONS} entries`);
  const parsed: Record<string, DecisionQuestion> = {};
  for (const [key, value] of entries) {
    const question = value as Record<string, unknown>;
    const type = question?.type;
    if (type !== 'choice' && type !== 'noul' && type !== 'boolean') invalid(`questions.${key}.type must be choice, noul or boolean`);
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) invalid(`questions.${key}.instructions is required`);
    if (type === 'choice') {
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) invalid(`questions.${key}.criteria must be an object of options`);
      const options = Object.entries(criteria as Record<string, unknown>).map(([name, text]) => [name, String(text ?? '')] as const);
      if (options.length < 1 || options.length > MAX_OPTIONS) invalid(`questions.${key}.criteria must hold 1 to ${MAX_OPTIONS} options`);
      parsed[key] = { type, instructions: question.instructions, criteria: Object.fromEntries(options) };
    } else {
      parsed[key] = { type, instructions: question.instructions };
    }
  }
  return {
    ...(typeof model === 'string' ? { model } : {}),
    state: state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : {},
    questions: parsed,
  };
}

function clip(text: string, length = MAX_TEXT) {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function decisionMessages(request: DecisionRequest): ChatMessage[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(request.state)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text) lines.push(`${key}: ${clip(text)}`);
  }
  const questions = Object.entries(request.questions).map(([key, question]) => {
    if (question.type === 'choice') {
      const options = Object.entries(question.criteria ?? {}).map(([name, text]) => `  - "${name}": ${clip(text, 800)}`).join('\n');
      return `"${key}" (choice): ${question.instructions}\n  Options:\n${options}`;
    }
    return `"${key}" (yes/no): ${question.instructions}`;
  });
  const shape = Object.entries(request.questions).map(([key, question]) => question.type === 'choice'
    ? `"${key}": {"probabilities": {${Object.keys(question.criteria ?? {}).map(name => `"${name}": 0.0`).join(', ')}}}`
    : `"${key}": {"yes": 0.0}`).join(', ');
  return [
    {
      role: 'system',
      content: 'You are a calibrated decision model. Read the situation and answer every question with probabilities, not prose. '
        + 'For a choice question give every option a probability; they sum to 1. For a yes/no question give the probability that the answer is yes. '
        + 'Use the exact question keys and option names. Answer at once without explaining. Reply with one JSON object and nothing else.',
    },
    {
      role: 'user',
      content: `Situation:\n${lines.join('\n') || '(none)'}\n\nQuestions:\n${questions.join('\n\n')}\n\nReply as JSON: {${shape}}`,
    },
  ];
}

function jsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ProviderError('The decision model did not answer with JSON', 'upstream', 502);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ProviderError('The decision model answered with broken JSON', 'upstream', 502);
  }
}

function probability(value: unknown) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : undefined;
}

export function readDecisionAnswers(request: DecisionRequest, text: string): Record<string, DecisionAnswer> {
  const reply = jsonObject(text);
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    const raw = reply[key] as Record<string, unknown> | number | undefined;
    if (question.type === 'choice') {
      const names = Object.keys(question.criteria ?? {});
      const given = (raw && typeof raw === 'object' ? (raw.probabilities ?? raw) : {}) as Record<string, unknown>;
      const weights = names.map(name => Math.max(0, Number(given[name]) || 0));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const probabilities = Object.fromEntries(names.map((name, index) => [name, total > 0 ? weights[index]! / total : 1 / names.length]));
      const choice = names.reduce((best, name) => probabilities[name]! > probabilities[best]! ? name : best, names[0]!);
      answers[key] = { choice, confidence: probabilities[choice]!, probabilities };
    } else {
      const yes = probability(typeof raw === 'object' && raw ? raw.yes ?? raw.noul ?? raw.probability : raw) ?? 0.5;
      answers[key] = question.type === 'boolean'
        ? { boolean: yes >= 0.5, probability: yes }
        : { noul: yes, confidence: Math.max(yes, 1 - yes) };
    }
  }
  return answers;
}

export async function decide<T>(request: DecisionRequest, complete: (messages: ChatMessage[], read: (text: string) => Record<string, DecisionAnswer>) => Promise<T>) {
  return complete(decisionMessages(request), text => readDecisionAnswers(request, text));
}
