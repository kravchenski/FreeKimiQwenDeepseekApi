import type { Page } from 'playwright-core';

import { solveCheckbox } from './checkbox.ts';
import { solveSlider } from './slider.ts';
import type { CaptchaHints, SolveOutcome } from './types.ts';

export type { CaptchaHints, SolveOutcome } from './types.ts';

export async function autoSolveCaptcha(page: Page, hints: CaptchaHints = {}): Promise<SolveOutcome> {
  try {
    let best: SolveOutcome = 'absent';
    if (hints.checkbox !== false) {
      const checkboxHints = typeof hints.checkbox === 'object' ? hints.checkbox : {};
      const outcome = await solveCheckbox(page, checkboxHints);
      if (outcome === 'solved') return outcome;
      if (outcome === 'failed') best = outcome;
    }
    if (hints.slider !== false) {
      const sliderHints = typeof hints.slider === 'object' ? hints.slider : {};
      const outcome = await solveSlider(page, sliderHints);
      if (outcome === 'solved') return outcome;
      if (outcome === 'failed') best = outcome;
    }
    return best;
  } catch {
    return 'failed';
  }
}
