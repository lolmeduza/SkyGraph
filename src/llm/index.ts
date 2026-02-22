import * as vscode from 'vscode';
import { LLMConfig, LLMMessage, LLMUsage } from './types';
import { getLLMConfig } from './config';
import { chatCompletion, estimateTokens } from './provider';
import { TOOLS, executeTool, ToolResultWithDiff } from './tools';

let currentConfig: LLMConfig | null = null;

export function initLLM(config: LLMConfig | null): void {
  currentConfig = config;
}

export interface ChatResult {
  content: string | null;
  usage?: LLMUsage;
  toolsUsed?: string[];
}

export async function chat(messages: LLMMessage[]): Promise<ChatResult> {
  const config = currentConfig ?? getLLMConfig();
  if (!config?.enabled) return { content: null };
  console.log('[ProjectCreator] LLM request:', messages.length, 'messages, ~', estimateTokens(messages.map((m) => m.content ?? '').join('')), 'tokens');
  const response = await chatCompletion(config, messages);
  const out = response?.content ?? null;
  const u = response?.usage;
  console.log('[ProjectCreator] LLM response:', out ? `${out.length} chars` : 'null', u ? `| prompt: ${u.prompt_tokens}, completion: ${u.completion_tokens ?? '?'}` : '');
  return {
    content: out,
    usage: response?.usage,
  };
}

const MAX_TOOL_ROUNDS = 20;

export interface ChatWithToolsOptions {
  onToolProgress?: (toolName: string) => void;
  onProposeEditsDiff?: (
    files: { path: string; originalContent: string; proposedContent: string }[],
    edits: { path: string; content: string }[]
  ) => void;
}

export async function chatWithTools(
  messages: LLMMessage[],
  workspaceUri: vscode.Uri | undefined,
  options?: ChatWithToolsOptions | ((toolName: string) => void)
): Promise<ChatResult> {
  const onToolProgress = typeof options === 'function' ? options : options?.onToolProgress;
  const onProposeEditsDiff = typeof options === 'object' ? options?.onProposeEditsDiff : undefined;

  const config = currentConfig ?? getLLMConfig();
  if (!config?.enabled) return { content: null };

  const useTools = !!workspaceUri;
  const loop: LLMMessage[] = [...messages];
  const toolsUsed: string[] = [];
  let proposeEditsAttempt = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const totalText = loop.map((m) => m.content ?? '').join('');
    console.log(`[ProjectCreator] LLM request (round ${round}):`, loop.length, 'messages, ~', estimateTokens(totalText), 'tokens');

    const response = await chatCompletion(config, loop, {
      tools: useTools ? TOOLS : undefined,
    });
    if (!response) return { content: null, toolsUsed };

    const u = response.usage;
    if (response.tool_calls && response.tool_calls.length > 0) {
      const names = response.tool_calls.map((tc) => tc.function.name);
      console.log(`[ProjectCreator] LLM wants tools:`, names.join(', '));

      loop.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      });

      for (const tc of response.tool_calls) {
        toolsUsed.push(tc.function.name);
        onToolProgress?.(tc.function.name);
        if (tc.function.name === 'propose_edits') proposeEditsAttempt++;
        const toolCtx = tc.function.name === 'propose_edits' ? { proposeEditsAttempt } : undefined;
        const result = await executeTool(tc, workspaceUri!, toolCtx);
        const content = typeof result === 'object' && result && 'result' in result
          ? (result as ToolResultWithDiff).result
          : (result as string);
        if (typeof result === 'object' && result?.diffPayload) {
          let edits: { path: string; content: string }[] = [];
          try {
            const args = JSON.parse(tc.function.arguments);
            if (Array.isArray(args.edits)) edits = args.edits.map((e: { path: string; content: string }) => ({ path: String(e.path).replace(/\\/g, '/'), content: typeof e.content === 'string' ? e.content : String(e.content) }));
          } catch { /* ignore */ }
          onProposeEditsDiff?.(result.diffPayload!.files, edits);
        }
        loop.push({
          role: 'tool',
          tool_call_id: tc.id,
          content,
        });
      }
      continue;
    }

    const out = response.content ?? null;
    console.log(
      '[ProjectCreator] LLM response:',
      out ? `${out.length} chars` : 'null',
      u ? `| prompt: ${u.prompt_tokens}, completion: ${u.completion_tokens ?? '?'}` : '',
      toolsUsed.length ? `| tools: ${toolsUsed.join(', ')}` : ''
    );
    return { content: out, usage: response.usage, toolsUsed };
  }

  console.warn('[ProjectCreator] Agent loop hit max rounds');
  const last = loop.filter((m) => m.role === 'assistant' && m.content).pop();
  return { content: last?.content ?? null, toolsUsed };
}
