import { ToolHandler, ToolDefinition, ToolContext, ToolResultWithDiff } from './types';
import * as vscode from 'vscode';
import { LLMToolCall } from '../types';

const registry = new Map<string, ToolHandler>();

export function register(handler: ToolHandler): void {
  registry.set(handler.name, handler);
}

export function getDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((h) => ({
    type: 'function' as const,
    function: {
      name: h.name,
      description: h.description,
      parameters: h.parameters,
    },
  }));
}

export async function execute(
  call: LLMToolCall,
  workspaceUri: vscode.Uri,
  context?: ToolContext
): Promise<string | ToolResultWithDiff> {
  const name = call.function.name;
  const handler = registry.get(name);
  
  if (!handler) {
    return `Неизвестный инструмент: ${name}`;
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return 'Ошибка: невалидный JSON аргументов';
  }

  try {
    return await handler.execute(args, workspaceUri, context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SkyGraph] ✗ Tool error (${name}):`, msg);
    return `Ошибка: ${msg}`;
  }
}

export function getHandler(name: string): ToolHandler | undefined {
  return registry.get(name);
}

export function getAllHandlers(): ToolHandler[] {
  return Array.from(registry.values());
}
