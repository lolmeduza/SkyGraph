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
      return (choices[0] as { message?: ChoiceMessage }).message ?? null;
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

export async function chatCompletion(
  config: LLMConfig,
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number; tools?: ToolDefinition[] }
): Promise<LLMResponse | null> {
  const url = config.url || 'http://localhost:11434/v1/chat/completions';
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
  const totalText = messages.map((m) => (typeof m.content === 'string' ? m.content : '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')).join('');
  const estTokens = estimateTokens(totalText);

  console.log(
    '[ProjectCreator LLM] POST',
    logUrl(url),
    '| body',
    bodyChars,
    'chars | messages',
    messages.length,
    '| ~',
    estTokens,
    'tokens'
  );

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(
        '[ProjectCreator LLM] HTTP',
        res.status,
        res.statusText,
        '| response:',
        errText.slice(0, 400)
      );
      throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
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
    console.error(
      '[ProjectCreator LLM] Error:',
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
