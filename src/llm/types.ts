export interface LLMConfig {
  provider: 'local' | 'openai' | 'ollama';
  url?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  enabled?: boolean;
  contextWindow?: number;
}

export interface LLMUsage {
  prompt_tokens: number;
  completion_tokens?: number;
}

export interface LLMResponse {
  content: string | null;
  usage?: LLMUsage;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

