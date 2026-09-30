const STRONG = /gpt-oss[-:]?120b|nemotron-3-(?:super|ultra)|gemma-?4|llama-3\.3-70b|qwen3|deepseek|glm|kimi|minimax|mistral-(?:medium|large)|devstral|coder/i;
const WEAK = /nano|mini|small|lite|tiny|vision|calibration|guard|safety|\b(?:[1-9]|1[0-4])b\b|-(?:[1-9]|1[0-4])b\b/i;

export function modelStrength(model: string) {
  return WEAK.test(model) ? 2 : STRONG.test(model) ? 0 : 1;
}
