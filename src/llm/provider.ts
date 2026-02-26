import { LLMConfig, LLMMessage, LLMResponse, LLMToolCall, LLMUsage } from './types';
import { ToolDefinition } from './tools';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractUsage(data: unknown): LLMUsage | undefined {
  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
  if (usage && typeof usage.prompt_tokens === 'number') {
    return {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    };
  }
  return undefined;
}

interface ChoiceMessage {
  content?: string | null;
  tool_calls?: LLMToolCall[];
}

function extractMessage(data: unknown): ChoiceMessage | null {
  if (data && typeof data === 'object' && 'choices' in data) {
    const choices = (data as { choices?: unknown[] }).choices;
    if (Array.isArray(choices) && choices[0]) {
      const message = (choices[0] as { message?: ChoiceMessage }).message;
      if (message) {
        // Parse DeepSeek/custom format: <|channel|>commentary functions<|message|>function_name({args})
        if (message.content && typeof message.content === 'string') {
          const parsed = parseDeepSeekToolCall(message.content);
          if (parsed) {
            console.log(`[SkyGraph] 🔧 Parsed custom tool format: ${parsed.function.name}(${parsed.function.arguments.slice(0, 80)}...)`);
            return {
              content: null,
              tool_calls: [parsed],
            };
          }
        }
        return message;
      }
    }
  }
  return null;
}

function parseDeepSeekToolCall(content: string): LLMToolCall | null {
  const knownTools = ['search_files', 'read_file', 'grep', 'search_and_read', 'propose_edits', 'get_project_commands'];
  
  // Try multiple patterns in specificity order; no bare tool_name({}) pattern to avoid false positives
  const patterns: { re: RegExp; needsBraces?: boolean }[] = [
    // Pattern 1: <|channel|>...functions.tool_name({args})
    { re: /<\|channel\|>[^<]*<\|message\|>\s*functions[\s.:]+(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/ },
    // Pattern 2: <|channel|>...functions.tool_name(key: "value", ...) - БЕЗ ФИГУРНЫХ СКОБОК
    { re: /<\|channel\|>[^<]*<\|message\|>\s*functions[\s.:]+(\w+)\s*\(\s*([^)]+)\s*\)/, needsBraces: true },
    // Pattern 3: functions.tool_name({args})
    { re: /functions[\s.:]+(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/ },
  ];

  for (const { re, needsBraces } of patterns) {
    const match = content.match(re);
    if (match) {
      const functionName = match[1];
      if (!knownTools.includes(functionName)) continue;
      
      let argsJson = match[2];
      
      // Если нужны фигурные скобки — добавляем
      if (needsBraces && !argsJson.trim().startsWith('{')) {
        argsJson = `{${argsJson}}`;
      }
      
      // Try to parse as-is first
      try {
        const parsed = JSON.parse(argsJson);
        return {
          id: 'call_' + Date.now(),
          type: 'function',
          function: {
            name: functionName,
            arguments: JSON.stringify(parsed),
          },
        };
      } catch {
        // Try fixing: unquoted keys and values
        let fixed = argsJson
          .replace(/(\w+)\s*:/g, '"$1":') // Add quotes to keys
          .replace(/:\s*'([^']*)'/g, ':"$1"') // Single quotes to double
          .replace(/:\s*([a-zA-Z][a-zA-Z0-9\s_\-./]*?)([,}])/g, (_m, val, end) => {
            const trimmed = val.trim();
            // Don't quote booleans, numbers, null
            if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null' || !isNaN(Number(trimmed))) {
              return `:${trimmed}${end}`;
            }
            return `:"${trimmed}"${end}`;
          })
          .replace(/"{2,}/g, '"'); // Remove duplicate quotes
        
        try {
          const parsed = JSON.parse(fixed);
          return {
            id: 'call_' + Date.now(),
            type: 'function',
            function: {
              name: functionName,
              arguments: JSON.stringify(parsed),
            },
          };
        } catch (e) {
          console.warn(`[SkyGraph] Failed to parse tool call: ${functionName}`, argsJson.slice(0, 80));
        }
      }
    }
  }
  
  return null;
}

function logUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 60) + (url.length > 60 ? '...' : '');
  }
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1/chat/completions';

function resolveLLMUrl(config: LLMConfig): string {
  if (config.url && config.url.trim()) return config.url.trim();
  if (config.provider === 'openai') return OPENAI_URL;
  return OLLAMA_DEFAULT_URL;
}

// Коды HTTP которые имеет смысл ретраить (временные ошибки сервера/перегрузка)
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.message.includes('aborted') || err.message.includes('abort');
}

function isRetryableError(err: unknown): boolean {
  if (isAbortError(err)) return false; // abort не ретраим
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // fetch failed — сетевая ошибка (таймаут, разрыв соединения)
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('econnreset') || msg.includes('etimedout')) return true;
  // HTTP статус в сообщении (мы сами бросаем "504: ...")
  const statusMatch = msg.match(/^(\d{3}):/);
  if (statusMatch) return RETRYABLE_HTTP.has(Number(statusMatch[1]));
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatCompletion(
  config: LLMConfig,
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number; tools?: ToolDefinition[]; signal?: AbortSignal }
): Promise<LLMResponse | null> {
  const url = resolveLLMUrl(config);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  const rawMax = options?.maxTokens ?? config.maxTokens ?? 4096;
  const max_tokens = Math.min(Math.max(rawMax, 100), 128000);

  const body: Record<string, unknown> = {
    model: config.model || '',
    messages,
    max_tokens,
    temperature: options?.temperature ?? config.temperature ?? 0.1,
  };
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
  }

  const bodyStr = JSON.stringify(body);
  const bodyChars = bodyStr.length;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (options?.signal?.aborted) return null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: options?.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(
          '[SkyGraph LLM] HTTP',
          res.status,
          res.statusText,
          '| response:',
          errText.slice(0, 400)
        );
        const err = new Error(`${res.status}: ${errText.slice(0, 200)}`);
        if (RETRYABLE_HTTP.has(res.status) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          console.warn(`[SkyGraph LLM] HTTP ${res.status} — повтор через ${delay}ms (попытка ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }
        throw err;
      }
      const data: unknown = await res.json();
      const msg = extractMessage(data);
      const usage = extractUsage(data);
      const content = msg?.content && typeof msg.content === 'string' ? msg.content : null;
      const tool_calls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : undefined;
      if (!content && !tool_calls) return null;
      return { content, usage, tool_calls };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[SkyGraph LLM] ${msg} — повтор через ${delay}ms (попытка ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }
      if (isAbortError(err)) {
        console.log('[SkyGraph LLM] Запрос отменён пользователем');
        return null;
      }
      console.error(
        '[SkyGraph LLM] Error:',
        msg,
        '| request:',
        logUrl(url),
        'body',
        bodyChars,
        'chars, messages',
        messages.length
      );
      return null;
    }
  }
  return null;
}
