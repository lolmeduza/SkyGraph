import * as vscode from 'vscode';
import { getPanelMarkup } from './markup';
import { getHistory, saveChat, removeChat, getPanelState, savePanelState, ensureUserInstructionsFile, readLLMMistakes } from '../history';
import { chat, chatWithTools } from '../llm';
import { getLLMConfig } from '../llm/config';
import { estimateTokens } from '../llm/provider';
import { getSystemPrompt, SUMMARIZE_SYSTEM_PROMPT } from '../llm/system-prompt';
import { getFinderProjectContext, getActiveFileRelative } from '../context/finder-graph';

const CONTEXT_COMPRESS_THRESHOLD = 0.8;
const USER_INSTRUCTIONS_FILE = 'user-instructions.md';
const viewType = 'skyGraph.panel';

let currentPanel: vscode.WebviewPanel | null = null;
const lastProposedEditsByChat: Record<string, { path: string; content: string }[]> = {};

function safePostMessage(panel: vscode.WebviewPanel, msg: object): void {
  try {
    if (panel.visible !== false) panel.webview.postMessage(msg);
  } catch {
    // Webview is disposed
  }
}

export function getPanel(): vscode.WebviewPanel | null {
  return currentPanel ?? null;
}

function getWorkspaceFolderUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) return folder.uri;
  const doc = vscode.window.activeTextEditor?.document?.uri;
  if (doc) return vscode.workspace.getWorkspaceFolder(doc)?.uri;
  return undefined;
}

async function readUserInstructionsFromWorkspace(workspaceUri: vscode.Uri): Promise<string | null> {
  const fileUri = vscode.Uri.joinPath(workspaceUri, '.skyGraph', USER_INSTRUCTIONS_FILE);
  try {
    const data = await vscode.workspace.fs.readFile(fileUri);
    const raw = new TextDecoder().decode(data).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

async function readFileRange(
  workspaceUri: vscode.Uri,
  filePath: string,
  fromLine?: number,
  toLine?: number
): Promise<string | null> {
  try {
    const uri = vscode.Uri.joinPath(workspaceUri, filePath.replace(/\\/g, '/'));
    const data = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(data);
    if (typeof fromLine !== 'number') return text;
    const lines = text.split('\n');
    const from = Math.max(0, fromLine - 1);
    const to = typeof toLine === 'number' ? Math.min(lines.length - 1, toLine - 1) : from;
    return lines.slice(from, to + 1).join('\n');
  } catch {
    return null;
  }
}

async function buildAttachedFilesText(
  workspaceUri: vscode.Uri,
  files: { path: string; fromLine?: number; toLine?: number }[]
): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    const content = await readFileRange(workspaceUri, f.path, f.fromLine, f.toLine);
    if (content === null) continue;
    const rangeLabel =
      typeof f.fromLine === 'number'
        ? ` (строки ${f.fromLine}${typeof f.toLine === 'number' && f.toLine !== f.fromLine ? '–' + f.toLine : ''})`
        : '';
    parts.push(`=== Файл: ${f.path}${rangeLabel} ===\n${content}`);
  }
  return parts.join('\n\n');
}

async function runLLMRequest(
  panel: vscode.WebviewPanel,
  opts: {
    chatId: string;
    userText: string;
    history: { role: string; text: string }[];
    noContext: boolean;
    workspaceUri: vscode.Uri | undefined;
    logLabel?: string;
    attachedFiles?: { path: string; fromLine?: number; toLine?: number }[];
  }
): Promise<void> {
  const { chatId, userText, history, noContext, workspaceUri, logLabel, attachedFiles } = opts;

  let effectiveUserText = userText;
  if (attachedFiles && attachedFiles.length > 0 && workspaceUri) {
    const filesText = await buildAttachedFilesText(workspaceUri, attachedFiles);
    if (filesText) effectiveUserText = filesText + '\n\n' + userText;
  }

  const [userInstructions, llmMistakes] = await Promise.all([
    workspaceUri ? readUserInstructionsFromWorkspace(workspaceUri) : Promise.resolve(null),
    workspaceUri ? Promise.resolve(readLLMMistakes(workspaceUri.fsPath)) : Promise.resolve(null),
  ]);
  const projectContext =
    !noContext && workspaceUri
      ? await getFinderProjectContext(workspaceUri, getActiveFileRelative(workspaceUri), effectiveUserText)
      : null;
  const len = !noContext ? (projectContext?.length ?? 0) : 0;
  if (!noContext) console.log(`[SkyGraph] Контекст проекта${logLabel ? ` (${logLabel})` : ''}:`, len ? `${len} символов` : 'нет');
  if (llmMistakes) console.log('[SkyGraph] LLM mistakes loaded:', llmMistakes.split('\n').length, 'строк');
  safePostMessage(panel, { type: 'projectContextUsed', chars: len });

  const systemContent = getSystemPrompt(!noContext, userInstructions, projectContext, llmMistakes);
  const config = getLLMConfig();
  const contextLimit = config?.contextWindow ?? 128000;

  let activeHistory = history;
  const promptText = systemContent + activeHistory.map((m) => m.text).join('') + effectiveUserText;
  if (estimateTokens(promptText) > contextLimit * CONTEXT_COMPRESS_THRESHOLD && activeHistory.length > 0) {
    const toCompress = activeHistory.map((m) => `${m.role}: ${m.text}`).join('\n\n');
    const summaryResult = await chat([
      { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
      { role: 'user', content: toCompress },
    ]);
    const summary = summaryResult.content?.trim() ?? '';
    activeHistory = [{ role: 'user', text: '[Контекст сжат]\n' + summary }];
    safePostMessage(panel, { type: 'replaceHistory', chatId, messages: activeHistory });
  }

  const llmMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemContent },
    ...activeHistory.map((m) => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.text,
    })),
    { role: 'user', content: effectiveUserText },
  ];

  void (chatWithTools(llmMessages, workspaceUri, {
    onToolProgress: (toolName) => safePostMessage(panel, { type: 'toolProgress', tool: toolName, chatId }),
    onThinkResult: (reasoning) => safePostMessage(panel, { type: 'thinkResult', reasoning, chatId }),
    onProposeEditsDiff: (files, edits) => {
      lastProposedEditsByChat[chatId] = edits;
      safePostMessage(panel, { type: 'showDiff', files, chatId });
    },
  })
    .then((result) => {
      const content = result.content ?? 'Ошибка или LLM не настроен.';
      const isError = result.content === null;
      const contextUsed =
        result.usage?.prompt_tokens ??
        result.contextTracker?.usedTokens ??
        estimateTokens(systemContent + activeHistory.map((m) => m.text).join('') + effectiveUserText + content);
      safePostMessage(panel, {
        type: 'assistantMessage',
        text: content,
        chatId,
        isError,
        contextUsed,
        contextLimit,
        toolsUsed: result.toolsUsed,
      });
    })
    .catch((err) => {
      const text = err?.message?.includes('504')
        ? 'Таймаут (504 Gateway Time-out). Увеличьте таймаут прокси или повторите позже.'
        : String(err?.message ?? err);
      safePostMessage(panel, {
        type: 'assistantMessage',
        text,
        chatId,
        isError: true,
        contextUsed: 0,
        contextLimit,
        toolsUsed: [],
      });
    }));
}

export function openPanel(context: vscode.ExtensionContext): void {
  if (currentPanel) {
    if (!currentPanel.visible) currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    viewType,
    'Sky Graph',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out')],
    }
  );
  currentPanel = panel;
  panel.onDidDispose(() => {
    currentPanel = null;
  });
  panel.webview.html = getPanelHtml(panel.webview, context);

  const workspaceUri = getWorkspaceFolderUri();
  const workspacePath = workspaceUri?.fsPath ?? '';
  if (workspacePath) ensureUserInstructionsFile(workspacePath);

  panel.webview.onDidReceiveMessage(
    async (message: {
      type: string;
      text?: string;
      chatId?: string;
      name?: string;
      path?: string;
      messages?: { role: string; text: string }[];
      noProjectContext?: boolean;
      openIds?: string[];
      activeId?: string;
      attachedFiles?: { path: string; fromLine?: number; toLine?: number }[];
      fromLine?: number;
      toLine?: number;
    }) => {
      const currentWorkspaceUri = getWorkspaceFolderUri();
      const currentWorkspacePath = currentWorkspaceUri?.fsPath ?? '';
      if (message.type === 'getHistory') {
        const chats = currentWorkspacePath ? getHistory(currentWorkspacePath) : [];
        const panelState = currentWorkspacePath ? getPanelState(currentWorkspacePath) : null;
        const config = getLLMConfig();
        panel.webview.postMessage({
          type: 'history',
          chats,
          openIds: panelState?.openIds,
          activeId: panelState?.activeId,
          contextLimit: config?.contextWindow ?? 128000,
          disableApply: true,
        });
        return;
      }
      if (message.type === 'savePanelState' && currentWorkspacePath) {
        const openIds = message.openIds;
        const activeId = message.activeId;
        if (Array.isArray(openIds) && typeof activeId === 'string') {
          savePanelState(currentWorkspacePath, openIds, activeId);
        }
        return;
      }
      if (message.type === 'send' && typeof message.text === 'string') {
        const chatId = message.chatId ?? '';
        panel.webview.postMessage({ type: 'userMessage', text: message.text, chatId });
        void runLLMRequest(panel, {
          chatId,
          userText: message.text,
          history: message.messages ?? [],
          noContext: message.noProjectContext === true,
          workspaceUri: currentWorkspaceUri,
          attachedFiles: message.attachedFiles,
        });
        return;
      }
      if (message.type === 'retry' && message.chatId && Array.isArray(message.messages)) {
        const chatId = message.chatId;
        const messages = message.messages as { role: string; text: string }[];
        if (messages.length === 0) return;
        const last = messages[messages.length - 1];
        const userText = typeof last?.text === 'string' ? last.text : '';
        void runLLMRequest(panel, {
          chatId,
          userText,
          history: messages.slice(0, -1),
          noContext: message.noProjectContext === true,
          workspaceUri: currentWorkspaceUri,
          logLabel: 'retry',
        });
        return;
      }
      if (message.type === 'persistChat' && message.chatId && currentWorkspacePath) {
        saveChat(
          currentWorkspacePath,
          message.chatId,
          message.name ?? 'Чат',
          message.messages ?? []
        );
        return;
      }
      if (message.type === 'removeChat' && message.chatId && currentWorkspacePath) {
        removeChat(currentWorkspacePath, message.chatId);
      }
      if (message.type === 'openFile' && typeof message.path === 'string') {
        const workspaceUri = getWorkspaceFolderUri();
        if (workspaceUri) {
          const uri = vscode.Uri.joinPath(workspaceUri, message.path.replace(/\\/g, '/'));
          vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.One });
        }
        return;
      }
      if (message.type === 'applyEdits' && message.chatId) {
        if (!currentWorkspaceUri) return;
        const toApply = lastProposedEditsByChat[message.chatId];
        if (!toApply?.length) return;
        delete lastProposedEditsByChat[message.chatId];
        const applyOne = async (e: { path: string; content: string }) => {
          const normalized = e.path.replace(/\\/g, '/');
          const uri = vscode.Uri.joinPath(currentWorkspaceUri, normalized);
          const parts = normalized.split('/');
          if (parts.length > 1) {
            for (let i = 1; i < parts.length; i++) {
              const dirPath = parts.slice(0, i).join('/');
              try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(currentWorkspaceUri, dirPath));
              } catch { /* уже есть */ }
            }
          }
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(e.content));
        };
        Promise.all(toApply.map(applyOne))
          .then(() => {
            safePostMessage(panel, { type: 'diffApplied' });
          })
          .catch((err) => {
            console.error('[SkyGraph] applyEdits failed:', err);
            safePostMessage(panel, { type: 'diffApplyError', message: String(err) });
          });
        return;
      }
    },
    undefined,
    context.subscriptions
  );
}

function getPanelHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'out', 'panel', 'styles', 'panel.css')
  );
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>${getPanelMarkup()}</body>
</html>`;
}
