import crypto from 'node:crypto';

function truncateForPrompt(value, maxLen = 240) {
    const text = String(value || '');
    return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
}

function compactJsonSchema(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 2) return schema;
    if (Array.isArray(schema)) return schema.slice(0, 20).map(item => compactJsonSchema(item, depth + 1));

    const out = {};
    for (const key of ['type', 'enum', 'required', 'default']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.description) out.description = truncateForPrompt(schema.description, depth === 0 ? 180 : 90);
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(schema.properties)) {
            out.properties[name] = compactJsonSchema(prop, depth + 1);
        }
    }
    if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
    if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
    if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
    return out;
}

export function normalizeToolDefinitions(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools.flatMap(tool => {
        if (tool?.type !== 'namespace' || !tool?.name || !Array.isArray(tool?.tools)) return [tool];
        return tool.tools
            .map(inner => {
                const fn = inner?.function || inner;
                if (!fn?.name) return null;
                return {
                    type: 'function',
                    function: {
                        name: fn.name,
                        namespace: tool.name,
                        qualified_name: `${tool.name}.${fn.name}`,
                        description: [tool.description, fn.description].filter(Boolean).join('\n\n'),
                        parameters: fn.parameters || { type: 'object', properties: {} }
                    }
                };
            })
            .filter(Boolean);
    });
}

export function toolsToPrompt(tools) {
    tools = normalizeToolDefinitions(tools);
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const priorityNames = new Set([
        'skill_view', 'skills_list', 'skill_manage',
        'read_file', 'search_files', 'write_file', 'patch', 'terminal', 'process',
        'web_search', 'web_extract', 'session_search', 'todo', 'clarify', 'delegate_task'
    ]);

    const schemas = tools.map(tool => {
        const fn = tool?.function || tool;
        if (!fn?.name) return null;
        return {
            name: fn.qualified_name || (fn.namespace ? `${fn.namespace}.${fn.name}` : fn.name),
            description: truncateForPrompt(fn.description || '', priorityNames.has(fn.name) ? 420 : 180),
            parameters: compactJsonSchema(fn.parameters || { type: 'object', properties: {} }),
            priority: priorityNames.has(fn.name) ? 0 : 1
        };
    }).filter(Boolean).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

    if (schemas.length === 0) return '';

    const toolNames = schemas.map(s => s.name).join(', ');
    const skillRules = schemas.some(s => s.name === 'skill_view') ? `
SKILL RULES ARE HARD REQUIREMENTS:
- If the system prompt says a skill MUST be loaded, you MUST call skill_view before answering.
- If the user asks about Hermes Agent setup/config/providers/models/tools/skills/gateway/plugins/troubleshooting, FIRST call:
  {"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}}]}
- If a task is related to any listed skill category, call skill_view with the most relevant skill name before giving the final answer.
- After receiving a skill_view result, use it, then continue normally or call the next needed tool.
` : '';

    return `

OPENAI-COMPATIBLE TOOL CALLING ADAPTER ACTIVE.
You are behind a proxy that converts your JSON into real OpenAI tool_calls. Native prose like "I will use X" is NOT a tool call.

Available tool names exactly:
${toolNames}

${skillRules}
GENERAL TOOL RULES:
- For greetings, thanks, casual conversation, explanations, and questions answer directly. Never call bash/terminal merely to print or echo a reply.
- For codebase tasks such as implement, fix, refactor, review, test, or inspect, you MUST call read/ls/find/grep/bash or another suitable workspace tool before making claims or giving a final answer.
- Never claim that a file exists, was deleted, changed, tested, or listed unless that fact came from a tool result in the current conversation.
- Do not print a shell command as a suggestion when you can call the corresponding tool yourself.
- Never simulate tools with XML, markdown, or prose such as <bash>...</bash>, <read>...</read>, [调用 read] [{"path":"..."}], Tool call: read (path), Tool call: write (path) followed by Content:, or fenced shell blocks. Emit a real JSON tool call instead.
- When the user asks you to implement, fix, or refactor, continue through inspection, edits, and verification. Do not stop to ask which approach they prefer unless required information cannot be discovered.
- When an action, lookup, file read/write, command, web search, calculation, or verification is needed, CALL A TOOL instead of describing the action.
- If the user asks you to do something, and a suitable tool exists, respond with a tool call first.
- Never invent tool results. After tool results appear in the conversation, use them to continue.
- Use exact tool names from the list above. Do not invent or rewrite namespace separators.
- Bare MCP server labels such as mcp__playwright, mcp__context7, mcp__exa, mcp__memory, mcp__fal_ai, and mcp__sequential_thinking are NOT callable tool names.
- For Playwright, call a concrete browser tool from the available tool names list. Never call bare mcp__playwright.
- Never output an empty tool_calls array. If no tool is needed, answer the user normally in plain text.
- For source-code changes, prefer patch/apply_patch. For a complete file replacement, use write/write_file with the final content.
- For small exact replacements, edit is allowed. Keep oldText/newText source syntax valid and preserve all quotes, backticks, asterisks, and escapes.
- Keep every JSON property name and path as one uninterrupted string. Never insert whitespace or line breaks inside names such as "content", "path", or "oldText".
- JSON string values must escape embedded newlines as \n. The outer tool-call JSON itself must remain valid and minified.
- When write content contains JSON or source code with double quotes, escape every inner double quote as \" so the outer tool-call JSON stays valid.
- Preserve source code exactly inside tool arguments. In particular, CSS comments must use /* comment */ with both asterisk characters.
- Preserve JavaScript and TypeScript delimiters exactly. Template literals containing \${...} require surrounding backticks, and selector strings passed to querySelector/querySelectorAll require quotes or backticks.

TOOL CALL OUTPUT FORMAT — ONLY when actually calling one or more tools, respond with minified JSON, no markdown, no prose:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

Multiple calls are allowed:
{"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}},{"name":"terminal","arguments":{"command":"pwd"}}]}

Supported fallback shapes also work, but the format above is preferred.

Compact tool schemas:
${JSON.stringify(schemas.map(({priority, ...schema}) => schema), null, 2)}

If no tool is needed and no skill rule applies, do not output JSON and answer normally in plain text.`;
}

const TOOL_CALL_JSON_KEYS = [
    'tool_calls', 'function_call', 'tool_call', 'name', 'tool', 'function',
    'arguments', 'args', 'input', 'path', 'content', 'edits', 'oldText', 'newText',
    'command'
];

export function repairToolCallJsonKeys(text) {
    let repaired = text;
    for (const key of TOOL_CALL_JSON_KEYS) {
        const splitKey = key.split('').join('\\s*');
        repaired = repaired.replace(new RegExp(`"${splitKey}"\\s*:`, 'g'), `"${key}":`);
    }
    return repaired;
}

export function extractFirstToolCallObject(text) {
    const start = text.indexOf('{"tool_calls"');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
    }
    return null;
}

export function hasObviouslyBrokenEditArguments(rawArgs) {
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
        return true;
    }
    if (!args || !Array.isArray(args.edits)) return false;

    return args.edits.some(edit => {
        const source = edit?.newText;
        if (typeof source !== 'string') return false;
        const hasInterpolationWithoutBackticks = source.includes('${') && !source.includes('`');
        const hasUnquotedSelector = /\bquerySelector(?:All)?\(\s*[.#][^"'`)]/.test(source);
        return hasInterpolationWithoutBackticks || hasUnquotedSelector;
    });
}

export function repairEditArguments(rawArgs) {
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : structuredClone(rawArgs);
    } catch {
        return rawArgs;
    }
    if (!args || !Array.isArray(args.edits)) return args;

    for (const edit of args.edits) {
        for (const field of ['oldText', 'newText']) {
            if (typeof edit?.[field] !== 'string') continue;
            let source = edit[field];
            source = source.replace(
                /\bquerySelector(All)?\(\s*([.#][^)\n]*\$\{[^)\n]*\}[^)\n]*)\)/g,
                (_match, all = '', selector) => `querySelector${all}(\`${selector}\`)`
            );
            source = source.replace(
                /^(\s*[\w.[\]]+\.textContent\s*=\s*)([^;\n]*\$\{[^;\n]*\}[^;\n]*);/gm,
                (_match, prefix, value) => `${prefix}\`${value.trim()}\`;`
            );
            edit[field] = source;
        }
    }
    return args;
}

export function recoverSimpleToolCalls(text) {
    const normalized = repairToolCallJsonKeys(text);
    const starts = [...normalized.matchAll(/\{\s*"name"\s*:\s*"(write|read)"\s*,\s*"arguments"\s*:\s*\{/g)];
    if (starts.length === 0) return null;

    const calls = [];
    for (let index = 0; index < starts.length; index++) {
        const name = starts[index][1];
        const start = starts[index].index;
        const end = index + 1 < starts.length ? starts[index + 1].index : normalized.length;
        const chunk = normalized.slice(start, end);
        const pathMatch = chunk.match(/"path"\s*:\s*"([^"]+)"/);
        if (!pathMatch) return null;
        const path = pathMatch[1].replace(/\s+/g, match => /[\r\n]/.test(match) ? '' : match);

        if (name === 'read') {
            calls.push({ name, arguments: { path } });
            continue;
        }

        const contentStart = chunk.search(/"content"\s*:\s*"/);
        if (contentStart < 0) return null;
        const afterOpeningQuote = chunk.indexOf('"', contentStart + chunk.slice(contentStart).indexOf(':') + 1) + 1;
        const contentEnd = chunk.lastIndexOf('"}');
        if (afterOpeningQuote <= 0 || contentEnd < afterOpeningQuote) return null;
        calls.push({
            name,
            arguments: {
                path,
                content: chunk.slice(afterOpeningQuote, contentEnd).replace(/\\n/g, '\n')
            }
        });
    }
    return calls;
}

export function recoverBrokenBashToolCall(text) {
    const normalized = repairToolCallJsonKeys(text);
    const match = normalized.match(/"name"\s*:\s*"(bash|terminal)"[\s\S]*?"command"\s*:\s*"([\s\S]*)"\s*\}\s*\}\s*\]\s*\}?$/);
    if (!match) return null;
    const command = match[2].replace(/"\s*"\s*$/, '"');
    return { name: match[1], arguments: { command } };
}

export function recoverXmlStyleToolCall(text) {
    const outer = text.match(/<function=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/function>/i);
    if (outer) {
        const name = outer[1].toLowerCase();
        const args = {};
        const paramRe = /<parameter=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRe.exec(outer[2])) !== null) {
            const value = paramMatch[2].trim().replace(/<\/[A-Za-z0-9_-]+>/g, '').trim();
            args[paramMatch[1].toLowerCase()] = value;
        }
        if (Object.keys(args).length > 0) {
            const pathTools = new Set(['read', 'read_file', 'ls', 'find', 'grep', 'search_files']);
            const commandTools = new Set(['bash', 'terminal']);
            if (commandTools.has(name)) return { name: 'bash', arguments: { command: args.command || Object.values(args)[0] } };
            if (pathTools.has(name) && args.path) return { name, arguments: { path: args.path } };
            return { name, arguments: args };
        }
    }

    const block = text.match(/<(bash|terminal|read|ls|find|grep)>\s*([\s\S]*?)\s*<\/\1>/i);
    if (!block) return null;
    const name = block[1].toLowerCase();
    const body = block[2].trim();
    if (name === 'bash' || name === 'terminal') {
        const read = body.match(/^read\s+(.+?)(?:\s+--limit\s+\d+)?$/);
        if (read) return { name: 'read', arguments: { path: read[1].trim() } };
        return { name: 'bash', arguments: { command: body } };
    }
    return { name, arguments: { path: body } };
}

export function recoverChineseStyleToolCall(text) {
    const marker = text.match(/\[调用\s+([A-Za-z0-9_-]+)\]\s*/);
    if (!marker || marker.index === undefined) return null;
    const jsonStart = marker.index + marker[0].length;
    const decoder = new TextDecoder();
    const bytes = new TextEncoder().encode(text.slice(jsonStart));
    for (let end = 1; end <= bytes.length; end++) {
        try {
            const parsed = JSON.parse(decoder.decode(bytes.slice(0, end)));
            const args = Array.isArray(parsed) ? parsed[0] : parsed;
            if (!args || typeof args !== 'object') return null;
            return { name: marker[1], arguments: args };
        } catch {
        }
    }
    return null;
}

export function recoverProseStyleToolCalls(text) {
    const matches = [...text.matchAll(/^[ \t]*Tool call:\s*([A-Za-z0-9_-]+)\s*\((.*)\)[ \t]*$/gim)];
    if (matches.length === 0) return null;

    const pathTools = new Set(['read', 'read_file', 'ls', 'find', 'grep', 'search_files']);
    const commandTools = new Set(['bash', 'terminal']);
    const writeTools = new Set(['write', 'write_file']);
    const calls = matches.map((match, index) => {
        const name = match[1];
        const value = match[2].trim();
        if (!value) return null;

        if (value.startsWith('{') || value.startsWith('[')) {
            try {
                const parsed = JSON.parse(value);
                const argumentsValue = Array.isArray(parsed) ? parsed[0] : parsed;
                if (argumentsValue && typeof argumentsValue === 'object') {
                    return { name, arguments: argumentsValue };
                }
            } catch {
                return null;
            }
        }

        if (writeTools.has(name)) {
            const segmentStart = (match.index || 0) + match[0].length;
            const segmentEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
            const segment = text.slice(segmentStart, segmentEnd);
            const contentMarker = segment.match(/^[ \t]*(?:Content|Содержимое):[ \t]*/im);
            if (!contentMarker || contentMarker.index === undefined) return null;
            let content = segment.slice(contentMarker.index + contentMarker[0].length).replace(/^\r?\n/, '').trimEnd();
            const wholeFence = content.match(/^```(?:html|css|javascript|js|typescript|ts|json|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
            if (wholeFence) content = wholeFence[1];
            return content ? { name, arguments: { path: value, content } } : null;
        }
        if (commandTools.has(name)) {
            return { name, arguments: { command: value } };
        }
        if (pathTools.has(name)) {
            return { name, arguments: { path: value } };
        }
        return null;
    }).filter(Boolean);
    return calls.length > 0 ? calls : null;
}

export function recoverFencedShellToolCalls(text) {
    const fencePattern = /```(?:bash|sh|shell|zsh)[ \t]*\r?\n([\s\S]*?)```/gi;
    const matches = [...text.matchAll(fencePattern)];
    if (matches.length === 0) return null;

    const prose = text.replace(fencePattern, ' ').replace(/\s+/g, ' ').trim();
    const hasExecutionIntent = /(?:давайте|провер(?:им|ю)|посмотр(?:им|ю)|изучу|запущу|выполню|let'?s|i(?:'ll| will) (?:run|check|inspect))/i.test(prose);
    const looksLikeInstructions = /(?:например|пример|запустите|используйте|выполните|for example|run this|use this|command:|(?:run|execute|use) (?:the |this )?command)/i.test(prose);
    if (!hasExecutionIntent || looksLikeInstructions) return null;

    const calls = matches.map(match => {
        const command = match[1].trim();
        if (!command || conversationalShellText('bash', { command })) return null;
        return { name: 'bash', arguments: { command } };
    }).filter(Boolean);
    return calls.length > 0 ? calls : null;
}

export function conversationalShellText(name, rawArgs) {
    if (name !== 'bash' && name !== 'terminal') return false;
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
        return null;
    }
    if (typeof args?.command !== 'string') return null;
    const match = args.command.match(/^\s*(?:echo|printf(?:\s+%s)?)\s+["']?([\s\S]*?)["']?\s*$/);
    return match ? match[1] : null;
}

function recoveredToolCalls(calls, allowedNames) {
    if (!calls || calls.some(call => allowedNames && !allowedNames.has(call.name))) return null;
    return calls.map((call, index) => ({
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        index
    }));
}

export function parseToolCallJson(content, tools = null) {
    if (typeof content !== 'string') return null;
    tools = normalizeToolDefinitions(tools);
    const allowedTools = Array.isArray(tools)
        ? new Map(tools.map(tool => {
            const fn = tool?.function || tool;
            const qualifiedName = fn?.qualified_name || (fn?.namespace ? `${fn.namespace}.${fn.name}` : fn?.name);
            return [qualifiedName, fn];
        }).filter(([name]) => Boolean(name)))
        : null;
    const allowedNames = allowedTools ? new Set(allowedTools.keys()) : null;
    let text = content.trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1].trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first > 0 || last !== text.length - 1) {
        if (first >= 0 && last > first) text = text.slice(first, last + 1);
    }
    const firstToolCall = extractFirstToolCallObject(content);
    const parseAttempts = [
        text,
        repairToolCallJsonKeys(text),
        firstToolCall,
        firstToolCall ? repairToolCallJsonKeys(firstToolCall) : null
    ].filter(Boolean);
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) && /\}\]\}\s*$/.test(text)) {
        parseAttempts.push(text.replace(/\}\]\}\s*$/, '}}]}'));
    }
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(text) && !/\}\s*$/.test(text)) {
        parseAttempts.push(text + '}');
    }
    const objTc = text.match(/^\s*\{\s*"tool_calls"\s*:\s*\{/);
    if (objTc) {
        const fixed = text.replace(/^\s*\{\s*"tool_calls"\s*:\s*\{/, '{"tool_calls":[{') + ']}';
        parseAttempts.push(fixed);
        parseAttempts.push(repairToolCallJsonKeys(fixed));
    }

    for (const candidate of parseAttempts) {
        try {
            const parsed = JSON.parse(candidate);
            let calls = null;
            if (Array.isArray(parsed.tool_calls)) {
                calls = parsed.tool_calls;
            } else if (parsed.function_call || parsed.tool_call) {
                calls = [parsed.function_call || parsed.tool_call];
            } else if (parsed.name || parsed.tool) {
                calls = [parsed];
            }
            if (!calls || calls.length === 0) continue;
            const mappedCalls = calls.map((call, index) => {
                const name = call.name || call.tool || call.function?.name;
                const rawArgs = call.arguments ?? call.args ?? call.input ?? call.function?.arguments ?? {};
                const normalizedArgs = name === 'edit' ? repairEditArguments(rawArgs) : rawArgs;
                const args = typeof normalizedArgs === 'string' ? normalizedArgs : JSON.stringify(normalizedArgs || {});
                if (!name || (allowedNames && !allowedNames.has(name))) return null;
                if (conversationalShellText(name, args)) return null;
                const definition = allowedTools?.get(name);
                return {
                    id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: {
                        name: definition?.name || name,
                        ...(definition?.namespace ? { namespace: definition.namespace } : {}),
                        arguments: args
                    },
                    index
                };
            }).filter(Boolean);
            if (mappedCalls.length !== calls.length) continue;
            return mappedCalls;
        } catch {
        }
    }
    const recovered = recoverSimpleToolCalls(text);
    if (recovered) return recoveredToolCalls(recovered, allowedNames);
    const recoveredBash = recoverBrokenBashToolCall(text);
    if (recoveredBash && !conversationalShellText(recoveredBash.name, recoveredBash.arguments)) {
        return recoveredToolCalls([recoveredBash], allowedNames);
    }
    const recoveredXml = recoverXmlStyleToolCall(content);
    if (recoveredXml) return recoveredToolCalls([recoveredXml], allowedNames);
    const recoveredChinese = recoverChineseStyleToolCall(content);
    if (recoveredChinese) return recoveredToolCalls([recoveredChinese], allowedNames);
    const recoveredProse = recoverProseStyleToolCalls(content);
    if (recoveredProse) return recoveredToolCalls(recoveredProse, allowedNames);
    const recoveredFencedShell = recoverFencedShellToolCalls(content);
    if (recoveredFencedShell) return recoveredToolCalls(recoveredFencedShell, allowedNames);
    return null;
}

