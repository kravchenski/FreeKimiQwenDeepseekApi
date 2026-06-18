import { Hono } from 'hono';
import { serve } from 'bun';
import { streamSSE } from 'hono/streaming';

const app = new Hono();

const port = Number(process.env.UI_PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const API_ENDPOINT = process.env.AGENT_API_URL || 'http://localhost:3260/api';

app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AIFORALL</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #1a1a1a;
      --bg-input: #252525;
      --text: #cccccc;
      --text-dim: #666666;
      --text-dim2: #555555;
      --accent: #a78bfa;
      --accent-green: #a3d9a5;
      --accent-yellow: #d4c5a9;
      --accent-green2: #7ee787;
      --purple-muted: #8b7bb5;
      --border: #333333;
      --separator: #333333;
      --tag-ts: #569cd6;
      --tag-py: #f0db4f;
      --tag-sh: #6a9955;
      --status-bright: #888888;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', 'Fira Code', monospace;
      font-size: 13px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .app {
      width: 100%;
      max-width: 820px;
      padding: 0 24px;
      display: flex;
      flex-direction: column;
      margin-top: -48px;
    }
    .top-bar {
      font-size: 11px;
      line-height: 16px;
      color: var(--text-dim2);
      margin-bottom: 32px;
      user-select: none;
    }
    .top-bar .cmd { color: var(--text-dim2); }
    .top-bar .status-line { margin-top: 2px; }
    .top-bar .check { color: var(--accent-green2); }
    .top-bar .num { color: var(--status-bright); }
    .top-bar .sep { color: var(--text-dim2); }
    .top-bar .tag {
      display: inline; padding: 1px 6px; border-radius: 3px;
      font-size: 10px; margin: 0 1px;
    }
    .top-bar .tag-ts { color: var(--tag-ts); background: rgba(86,156,214,0.1); }
    .top-bar .tag-py { color: var(--tag-py); background: rgba(240,219,79,0.08); }
    .top-bar .tag-sh { color: var(--tag-sh); background: rgba(106,153,85,0.1); }
    .logo { margin-bottom: 36px; user-select: none; }
    .logo pre { font-family: 'JetBrains Mono', monospace; font-size: 10px; line-height: 11px; letter-spacing: 0; color: #444; margin: 0; }
    .logo .l1 { color: #999; }
    .logo .l2 { color: #777; }
    .logo .l3 { color: #555; }
    .input-wrap { position: relative; width: 100%; }
    .input-field {
      width: 100%; background: var(--bg-input); border: none;
      border-left: 2px solid var(--accent); outline: none;
      color: var(--text); font-family: inherit; font-size: 13px;
      padding: 13px 16px 13px 16px; line-height: 20px;
      border-radius: 0 4px 4px 0; transition: background 0.15s;
    }
    .input-field::placeholder { color: var(--text-dim2); opacity: 1; }
    .input-field:focus { background: #282828; }
    .input-sep { height: 1px; background: var(--separator); width: 100%; }
    .model-bar {
      display: flex; align-items: center; margin-top: 8px;
      padding-left: 2px; font-size: 11.5px; line-height: 16px;
    }
    .model-bar .build { color: var(--accent); font-weight: 500; }
    .model-bar .sep { color: #444; margin: 0 7px; font-size: 11px; }
    .model-bar .model { color: var(--status-bright); }
    .model-bar .free { color: var(--accent-green2); font-size: 10.5px; }
    .model-bar .zen { color: var(--purple-muted); }
    .model-bar .max { color: var(--text-dim); }
    .bottom-bar {
      position: fixed; bottom: 28px; left: 50%;
      transform: translateX(-50%);
      font-size: 11px; color: var(--text-dim2);
      display: flex; align-items: center; gap: 14px;
    }
    .bottom-bar kbd { font-family: inherit; font-size: 11px; color: var(--status-bright); background: transparent; border: none; padding: 0; }
    .bottom-bar .label { color: var(--text-dim2); }
    .bottom-bar .dot-sep { color: #3a3a3a; }
    .response {
      display: none; position: fixed; top: 16px; right: 16px;
      width: 460px; max-height: 75vh; background: #222;
      border: 1px solid var(--border); border-radius: 8px;
      padding: 20px; font-size: 13px; line-height: 1.7;
      overflow-y: auto; z-index: 100;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    }
    .response.active { display: block; animation: fadeIn 0.2s ease-out; }
    .response pre {
      background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
      padding: 14px; margin: 10px 0; overflow-x: auto;
      font-size: 12px; line-height: 1.6;
    }
    .response code { font-family: 'JetBrains Mono', monospace; color: var(--accent); }
    .response strong { color: #e6e6e6; }
    .response .done { color: var(--accent-green2); margin-top: 12px; font-size: 12px; }
    .response .thinking-text { color: var(--accent); }
    @keyframes blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
    .cursor-blink {
      display: inline-block; width: 7px; height: 14px;
      background: var(--accent); margin-left: 2px;
      animation: blink 1s infinite; vertical-align: middle;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #4a4a4a; }
  </style>
</head>
<body>
  <div class="app">
    <div class="top-bar">
      <div class="cmd">FreeQwenApi · OpenCode API</div>
      <div class="status-line">
        <span class="check">✓</span><span class="sep"> Initialized · </span>
        <span class="num">5</span><span class="sep"> chunks · </span>
        <span class="num">2965</span><span class="sep"> tokens · </span>
        <span class="tag tag-ts">TypeScript</span>
        <span class="tag tag-py">Python</span>
        <span class="tag tag-sh">Shell/Bash</span>
      </div>
    </div>

    <div class="logo">
      <pre>
<span class="l1">██╗   ██╗ ██████╗ ██████╗ ███████╗██╗   ██╗ ██████╗ ██████╗ ███████╗</span>
<span class="l2">██║   ██║██╔═══██╗██╔══██╗██╔════╝██║   ██║██╔═══██╗██╔══██╗██╔════╝</span>
<span class="l2">██║   ██║██║   ██║██║  ██║█████╗  ██║   ██║██║   ██║██║  ██║█████╗  </span>
<span class="l2">╚██╗ ██╔╝██║   ██║██║  ██║██╔══╝  ╚██╗ ██╔╝██║   ██║██║  ██║██╔══╝  </span>
<span class="l1"> ╚████╔╝ ╚██████╔╝██████╔╝███████╗ ╚████╔╝ ╚██████╔╝██████╔╝███████╗</span>
<span class="l3">  ╚═══╝   ╚═════╝ ╚═════╝ ╚══════╝  ╚═══╝   ╚═════╝ ╚═════╝ ╚══════╝</span>
      </pre>
    </div>

    <div class="input-wrap">
      <input type="text" class="input-field" id="prompt"
        placeholder='Ask anything... "Fix a bug", "Explain code"'
        autocomplete="off" spellcheck="false" autofocus>
      <div class="input-sep"></div>
    </div>

    <div class="model-bar">
      <span class="build">Build</span>
      <span class="sep">·</span>
      <span class="model" id="model-name">DeepSeek V4 Flash</span>
      <span class="free">&nbsp;Free</span>
      <span class="sep">·</span>
      <span class="zen">AIFORALL Zen</span>
      <span class="sep">·</span>
      <span class="max" id="mode-toggle">max</span>
    </div>
  </div>

  <div class="response" id="response"></div>

  <div class="bottom-bar">
    <span><kbd>tab</kbd> <span class="label">agents</span></span>
    <span class="dot-sep">·</span>
    <span><kbd>ctrl+p</kbd> <span class="label">commands</span></span>
    <span class="dot-sep">·</span>
    <span><kbd>ctrl+h</kbd> <span class="label">help</span></span>
    <span class="dot-sep">·</span>
    <span><kbd>ctrl+l</kbd> <span class="label">clear</span></span>
  </div>

  <script>
    const prompt = document.getElementById('prompt');
    const response = document.getElementById('response');
    const models = ['DeepSeek V4 Flash', 'DeepSeek Reasoner', 'Kimi K2.6', 'Kimi K2.6 Thinking'];
    let modelIdx = 0;
    let mode = 'max';

    prompt.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const message = prompt.value.trim();
        if (!message) return;

        prompt.value = '';
        response.classList.add('active');
        response.innerHTML = '<span class="thinking-text">Thinking<span class="cursor-blink"></span></span>';

        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, stream: true })
          });

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let html = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            const lines = text.split('\\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                  response.innerHTML = formatHTML(html) + '<div class="done">Done</div>';
                  return;
                }
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    html += content;
                    response.innerHTML = formatHTML(html);
                    response.scrollTop = response.scrollHeight;
                  }
                } catch {}
              }
            }
          }
          response.innerHTML = formatHTML(html) + '<div class="done">Done</div>';
        } catch (err) {
          response.innerHTML = '<span style="color:#f87171;">Error: ' + err.message + '</span>';
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.ctrl && e.key === 'l') { e.preventDefault(); response.classList.remove('active'); response.innerHTML = ''; }
      if (e.key === 'Tab') { e.preventDefault(); cycleModel(); }
    });

    function cycleModel() {
      modelIdx = (modelIdx + 1) % models.length;
      document.getElementById('model-name').textContent = models[modelIdx];
    }

    function toggleMode() {
      mode = mode === 'max' ? 'plan' : 'max';
      document.getElementById('mode-toggle').textContent = mode;
    }

    document.getElementById('mode-toggle').addEventListener('click', toggleMode);

    function formatHTML(text) {
      return text
        .replace(/\`\`\`(\w+)?\n([\s\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\\n/g, '<br>');
    }

    prompt.focus();
  </script>
</body>
</html>`);
});

app.post('/api/chat', async (c) => {
  const { message, model = 'deepseek-default', stream = false } = await c.req.json();

  if (stream) {
    return streamSSE(c, async (s) => {
      try {
        const ep = API_ENDPOINT.replace(/\/?api\/?$/, '');
        const res = await fetch(`${ep}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: message }], stream: true })
        });

        const reader = res.body?.getReader();
        if (!reader) { await s.writeSSE({ data: JSON.stringify({ choices: [{ delta: { content: 'Error: No response body' } }] }) }); return; }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') { await s.writeSSE({ data: '[DONE]' }); return; }
              await s.writeSSE({ data });
            }
          }
        }
        await s.writeSSE({ data: '[DONE]' });
      } catch (error) {
        await s.writeSSE({ data: JSON.stringify({ error: error.message }) });
      }
    });
  }

  try {
    const ep = API_ENDPOINT.replace(/\/?api\/?$/, '');
    const res = await fetch(`${ep}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: message }], stream: false })
    });
    return c.json(await res.json());
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/health', async (c) => {
  try {
    const r = await fetch(`${API_ENDPOINT.replace(/\/api\/?$/, '')}/health`);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ status: 'error', message: e.message }, 500);
  }
});

export async function startWebUI() {
  console.log(`
  AIFORALL - Web Interface
  Free AI Coding Assistant for Everyone
  `);

  serve({ fetch: app.fetch, port, hostname: host, idleTimeout: 255 });
  console.log(`  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
}

if (import.meta.main) {
  startWebUI().catch(e => { console.error(e.message); process.exit(1); });
}
