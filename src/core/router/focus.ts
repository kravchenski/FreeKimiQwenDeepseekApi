export const AUTO_FOCUSES = ['general', 'coding', 'reasoning', 'fast'] as const;
export type AutoFocus = typeof AUTO_FOCUSES[number];

export const AUTO_MODES = ['fallback', 'race', 'decide'] as const;
export type AutoMode = typeof AUTO_MODES[number];

const FOCUS_MODELS: Record<AutoFocus, RegExp | undefined> = {
  general: undefined,
  coding: /cod(e|er|ing)|codestral|devstral|swe-/i,
  reasoning: /reason|think|\br1\b|-r1|qwq|magistral|gpt-oss|expert/i,
  fast: /flash|lightning|nano|mini|instant|small|turbo|\b8b\b|-8b/i,
};

export function isAutoFocus(value: unknown): value is AutoFocus {
  return typeof value === 'string' && (AUTO_FOCUSES as readonly string[]).includes(value);
}

export function isAutoMode(value: unknown): value is AutoMode {
  return typeof value === 'string' && (AUTO_MODES as readonly string[]).includes(value);
}

export function focusPreference(focus: AutoFocus) {
  const pattern = FOCUS_MODELS[focus];
  return (model: string) => (pattern?.test(model) ? 1 : 0);
}
