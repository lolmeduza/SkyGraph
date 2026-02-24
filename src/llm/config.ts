import * as vscode from 'vscode';
import { LLMConfig } from './types';

export function getLLMConfig(): LLMConfig | null {
  const config = vscode.workspace.getConfiguration('skyGraph.llm');
  const provider = config.get<'local' | 'openai' | 'ollama'>('provider', 'local');
  const url = config.get<string>('url', '');
  const apiKey = config.get<string>('apiKey') || undefined;
  const enabled =
    provider === 'openai' ? !!apiKey : true;

  if (!enabled) return null;

  return {
    provider,
    url: url?.trim() || undefined,
    apiKey,
    model: config.get<string>('model') || undefined,
    maxTokens: config.get<number>('maxTokens', 4096),
    temperature: config.get<number>('temperature', 0.1),
    contextWindow: config.get<number>('contextWindow', 128000),
    enabled: true,
  };
}
