import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchCdpBrowser } from '../src/browser/cdp.ts';
import { autoSolveCaptcha } from '../src/browser/captcha/index.ts';
import { solveCheckbox } from '../src/browser/captcha/checkbox.ts';
import { solveSlider } from '../src/browser/captcha/slider.ts';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';

const sliderPage = `<!doctype html><style>
body { margin: 0; padding: 20px; }
#widget { position: relative; width: 340px; height: 210px; background: #eee; }
#bg { position: absolute; left: 10px; top: 10px; width: 320px; height: 150px; }
#piece { position: absolute; left: 10px; top: 10px; width: 47px; height: 150px; z-index: 2; }
#track { position: absolute; left: 10px; top: 170px; width: 320px; height: 34px; background: #ddd; }
#handle { position: absolute; left: 0; top: 0; width: 46px; height: 34px; background: #666; }
</style>
<div id="widget" data-captcha="1">
  <img id="bg" alt="">
  <img id="piece" alt="">
  <div id="track"><div id="handle" class="drag-handle"></div></div>
</div>
<script>
const GAP = 197;
const canvas = document.createElement('canvas');
canvas.width = 320;
canvas.height = 150;
const context = canvas.getContext('2d');
const image = context.createImageData(320, 150);
let state = 12345;
for (let index = 0; index < image.data.length; index += 4) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  image.data[index] = state & 0xff;
  image.data[index + 1] = (state >>> 8) & 0xff;
  image.data[index + 2] = (state >>> 16) & 0xff;
  image.data[index + 3] = 255;
}
context.putImageData(image, 0, 0);
document.getElementById('bg').src = canvas.toDataURL();
const pieceCanvas = document.createElement('canvas');
pieceCanvas.width = 47;
pieceCanvas.height = 150;
pieceCanvas.getContext('2d').drawImage(canvas, GAP, 0, 47, 150, 0, 0, 47, 150);
document.getElementById('piece').src = pieceCanvas.toDataURL();

const bg = document.getElementById('bg');
const piece = document.getElementById('piece');
const handle = document.getElementById('handle');
let dragging = false;
let startX = 0;
let startPiece = 0;
handle.addEventListener('mousedown', event => {
  dragging = true;
  startX = event.clientX;
  startPiece = piece.offsetLeft - bg.offsetLeft;
  event.preventDefault();
});
document.addEventListener('mousemove', event => {
  if (!dragging) return;
  const delta = event.clientX - startX;
  const target = Math.max(0, Math.min(320 - piece.width, startPiece + delta));
  piece.style.left = bg.offsetLeft + target + 'px';
  handle.style.left = Math.max(0, Math.min(320 - handle.width, delta)) + 'px';
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  const moved = piece.offsetLeft - bg.offsetLeft;
  if (Math.abs(moved - GAP) <= 8) document.getElementById('widget').style.display = 'none';
});
</script>`;

const maskedSliderPage = sliderPage
  .replace('<div id="widget" data-captcha="1">', '<div id="fake-mask" class="captcha-mask" style="position:fixed;left:0;top:0;width:100vw;height:100vh;"></div>\n<div id="fake-popup" class="captcha-popup" style="position:relative;width:340px;height:210px;">\n<div id="widget">')
  .replace('document.getElementById(\'widget\').style.display = \'none\';', 'document.getElementById(\'fake-popup\').style.display = \'none\';')
  .replace('</div>\n<script>', '</div>\n</div>\n<script>');

const checkboxPage = `<!doctype html><style>body { margin: 0; padding: 20px; }</style>
<input id="token-out">
<iframe id="fake-cb" src="/cbframe" width="240" height="80"></iframe>`;

const cbframePage = `<!doctype html><style>
body { margin: 0; }
#box { position: absolute; left: 10px; top: 20px; width: 40px; height: 40px; background: #ccc; }
</style>
<div id="box"></div>
<script>
document.addEventListener('click', event => {
  if (event.clientX < 10 || event.clientX > 50 || event.clientY < 20 || event.clientY > 60) return;
  parent.document.getElementById('token-out').value = 'x'.repeat(40);
});
</script>`;

const plainPage = '<!doctype html><p>nothing to solve</p>';

let server: ReturnType<typeof Bun.serve>;
let origin = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const html = path === '/slider' ? sliderPage
        : path === '/masked-slider' ? maskedSliderPage
        : path === '/checkbox' ? checkboxPage
        : path === '/cbframe' ? cbframePage
        : plainPage;
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

async function withPage(run: (page: import('playwright-core').Page) => Promise<void>) {
  const cdp = await launchCdpBrowser({ profileDir: join(mkdtempSync(join(tmpdir(), 'captcha-')), 'profile'), headless: true });
  try {
    const page = await cdp.browser.contexts()[0]!.newPage();
    await run(page);
  } finally {
    await cdp.close();
  }
}

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('captcha solver', () => {
  test('drags a synthetic slider captcha to the gap', async () => {
    await withPage(async page => {
      await page.goto(`${origin}/slider`);
      expect(await solveSlider(page)).toBe('solved');
      expect(await page.locator('#widget').isVisible()).toBe(false);
    });
  });

  test('solves slider when a captcha-id mask overlay precedes the popup', async () => {
    await withPage(async page => {
      await page.goto(`${origin}/masked-slider`);
      expect(await solveSlider(page)).toBe('solved');
      expect(await page.locator('#fake-popup').isVisible()).toBe(false);
    });
  });

  test('clicks a synthetic checkbox captcha', async () => {
    await withPage(async page => {
      await page.goto(`${origin}/checkbox`);
      const outcome = await solveCheckbox(page, { iframe: '#fake-cb', response: '#token-out', timeoutMs: 5_000 });
      expect(outcome).toBe('solved');
      expect((await page.locator('#token-out').inputValue()).length).toBeGreaterThan(20);
    });
  });

  test('reports absent on a page without captcha', async () => {
    await withPage(async page => {
      await page.goto(`${origin}/plain`);
      expect(await autoSolveCaptcha(page)).toBe('absent');
    });
  });
});
