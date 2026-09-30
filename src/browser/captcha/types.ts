export type SolveOutcome = 'solved' | 'absent' | 'failed';

interface SliderAttempt {
  attempt: number;
  stage?: 'color' | 'enclosed' | 'edges' | 'ncc';
  x?: number;
  solved: boolean;
}

export interface SliderHints {
  container?: string;
  handle?: string;
  background?: string;
  piece?: string;
  success?: string;
  attempts?: number;
  onAttempt?: (info: SliderAttempt) => void;
}

export interface CheckboxHints {
  iframe?: string;
  response?: string;
  timeoutMs?: number;
}

export interface CaptchaHints {
  checkbox?: boolean | CheckboxHints;
  slider?: boolean | SliderHints;
}
