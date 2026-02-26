import * as vscode from 'vscode';
import { LLMConfig, LLMMessage, LLMUsage } from './types';
import { getLLMConfig } from './config';
import { chatCompletion } from './provider';
import { TOOLS, executeTool, ToolResultWithDiff } from './tools/index';
import { ContextTracker, ContextTrackerState } from '../context/token-usage';

let currentConfig: LLMConfig | null = null;

export function initLLM(config: LLMConfig | null): void {
  currentConfig = config;
}

export interface ChatResult {
  content: string | null;
  usage?: LLMUsage;
  toolsUsed?: string[];
  contextTracker?: ContextTrackerState;
}

export async function chat(messages: LLMMessage[]): Promise<ChatResult> {
  const config = currentConfig ?? getLLMConfig();
  if (!config?.enabled) return { content: null };
  const response = await chatCompletion(config, messages);
  const out = response?.content ?? null;
  const u = response?.usage;
  console.log(`[SkyGraph] LLM chat: ${out ? out.length + ' chars' : 'null'}${u ? ` (prompt: ${u.prompt_tokens}, comp: ${u.completion_tokens ?? '?'})` : ''}`);
  return {
    content: out,
    usage: response?.usage,
  };
}

const MAX_TOOL_ROUNDS = 20;

export interface ChatWithToolsOptions {
  onToolProgress?: (toolName: string) => void;
  onThinkResult?: (reasoning: string) => void;
  onProposeEditsDiff?: (
    files: { path: string; originalContent: string; proposedContent: string }[],
    edits: { path: string; content: string }[]
  ) => void;
  onCreatePlan?: (plan: import('./tools/handlers/create-plan').PlanData) => void;
  signal?: AbortSignal;
}

export async function chatWithTools(
  messages: LLMMessage[],
  workspaceUri: vscode.Uri | undefined,
  options?: ChatWithToolsOptions | ((toolName: string) => void)
): Promise<ChatResult> {
  const onToolProgress = typeof options === 'function' ? options : options?.onToolProgress;
  const onProposeEditsDiff = typeof options === 'object' ? options?.onProposeEditsDiff : undefined;
  const onThinkResult = typeof options === 'object' ? options?.onThinkResult : undefined;
  const onCreatePlan = typeof options === 'object' ? options?.onCreatePlan : undefined;
  const signal = typeof options === 'object' ? options?.signal : undefined;

  const config = currentConfig ?? getLLMConfig();
  if (!config?.enabled) return { content: null };

  const useTools = !!workspaceUri;
  const loop: LLMMessage[] = [...messages];
  const toolsUsed: string[] = [];
  let proposeEditsAttempt = 0;
  // Накапливаем диффы — показываем только после финального ответа LLM
  const pendingDiffFiles = new Map<string, { path: string; originalContent: string; proposedContent: string }>();
  let pendingDiffEdits = new Map<string, { path: string; content: string }>();

  const contextLimit = config.contextWindow ?? 128000;
  const tracker = new ContextTracker(contextLimit);
  for (const m of messages) {
    tracker.add(m.role, m.content ?? '');
  }

  console.log(`[SkyGraph] Messages: ${loop.length}, user query: ${String(loop[loop.length - 1]?.content ?? '').slice(0, 120)}`);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) {
      console.log('[SkyGraph] Запрос отменён до раунда', round);
      return { content: null, toolsUsed, contextTracker: tracker.getState() };
    }

    const tok = tracker.getUsed();
    console.log(`[SkyGraph] → Sending ${loop.length} messages (~${tok} tokens) to LLM`);

    const response = await chatCompletion(config, loop, {
      tools: useTools ? TOOLS : undefined,
      signal,
    });
    
    if (!response) {
      if (signal?.aborted) return { content: null, toolsUsed, contextTracker: tracker.getState() };
      console.error('[SkyGraph] ✗ LLM returned null response');
      return { content: null, toolsUsed };
    }

    const u = response.usage;
    console.log(`[SkyGraph] LLM response: ${response.content ? `${response.content.length} chars` : 'null'}, tools: ${response.tool_calls?.length ?? 0}${u ? `, tokens: ${u.prompt_tokens}→${u.completion_tokens ?? '?'}` : ''}`);

    if (response.tool_calls && response.tool_calls.length > 0) {
      const names = response.tool_calls.map((tc) => tc.function.name);
      console.log(`[SkyGraph] Tool calls: ${names.join(', ')}`);

      const assistantContent = response.content ?? '';
      tracker.add('assistant', assistantContent);
      loop.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      });

      for (const tc of response.tool_calls) {
        if (signal?.aborted) {
          console.log('[SkyGraph] Запрос отменён во время выполнения инструментов');
          return { content: null, toolsUsed, contextTracker: tracker.getState() };
        }

        toolsUsed.push(tc.function.name);
        onToolProgress?.(tc.function.name);
        
        console.log(`[SkyGraph]   Executing: ${tc.function.name}(${tc.function.arguments.slice(0, 80)}${tc.function.arguments.length > 80 ? '...' : ''})`);
        
        if (tc.function.name === 'propose_edits') proposeEditsAttempt++;
        const toolCtx = tc.function.name === 'propose_edits' ? { proposeEditsAttempt } : undefined;
        const result = await executeTool(tc, workspaceUri!, toolCtx);
        if (signal?.aborted) {
          console.log('[SkyGraph] Запрос отменён после выполнения', tc.function.name);
          return { content: null, toolsUsed, contextTracker: tracker.getState() };
        }
        const content = typeof result === 'object' && result && 'result' in result
          ? (result as ToolResultWithDiff).result
          : (result as string);
        
        console.log(`[SkyGraph]   Result: ${content.slice(0, 150)}${content.length > 150 ? '...' : ''}`);

        if (tc.function.name === 'think' && onThinkResult) {
          const match = content.match(/<think_result>\n?([\s\S]*?)\n?<\/think_result>/);
          if (match) onThinkResult(match[1].trim());
        }

        if (tc.function.name === 'create_plan' && onCreatePlan) {
          const match = content.match(/<plan_result>\n?([\s\S]*?)\n?<\/plan_result>/);
          if (match) {
            try {
              const plan = JSON.parse(match[1].trim());
              onCreatePlan(plan);
            } catch { /* ignore malformed plan */ }
          }
        }

        if (typeof result === 'object' && result?.diffPayload) {
          // Накапливаем — для каждого файла берём последнюю версию
          for (const f of result.diffPayload!.files) {
            pendingDiffFiles.set(f.path, f);
          }
          try {
            const args = JSON.parse(tc.function.arguments);
            if (Array.isArray(args.edits)) {
              for (const e of args.edits as { path: string; content: string }[]) {
                const p = String(e.path).replace(/\\/g, '/');
                pendingDiffEdits.set(p, { path: p, content: typeof e.content === 'string' ? e.content : String(e.content) });
              }
            }
          } catch { /* ignore */ }
        }
        tracker.add('tool', content);
        loop.push({
          role: 'tool',
          tool_call_id: tc.id,
          content,
        });
      }
      continue;
    }

    const out = response.content ?? null;
    if (out) tracker.add('assistant', out);
    console.log(`[SkyGraph] ✓ Final answer (${out?.length ?? 0} chars)${toolsUsed.length ? `, used tools: ${toolsUsed.join(' → ')}` : ''}`);
    if (pendingDiffFiles.size > 0 && onProposeEditsDiff) {
      onProposeEditsDiff([...pendingDiffFiles.values()], [...pendingDiffEdits.values()]);
    }
    return { content: out, usage: response.usage, toolsUsed, contextTracker: tracker.getState() };
  }

  console.warn('[SkyGraph] ⚠ Agent loop hit max rounds (20)');
  if (pendingDiffFiles.size > 0 && onProposeEditsDiff) {
    onProposeEditsDiff([...pendingDiffFiles.values()], [...pendingDiffEdits.values()]);
  }
  const last = loop.filter((m) => m.role === 'assistant' && m.content).pop();
  return { content: last?.content ?? null, toolsUsed, contextTracker: tracker.getState() };
}
