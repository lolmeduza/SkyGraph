import * as vscode from 'vscode';
import { getPanelMarkup } from './markup';
import { getHistory, saveChat, removeChat, getPanelState, savePanelState, ensureUserInstructionsFile } from '../history';
import { chat, chatWithTools } from '../llm';
import { getLLMConfig } from '../llm/config';
import { estimateTokens } from '../llm/provider';
import { getSystemPrompt, SUMMARIZE_SYSTEM_PROMPT } from '../llm/system-prompt';
import { getFinderProjectContext, getActiveFileRelative } from '../context/finder-graph';

const CONTEXT_COMPRESS_THRESHOLD = 0.8;
const USER_INSTRUCTIONS_FILE = 'user-instructions.md';
const viewType = 'projectCreator.panel';
const DISABLE_LLM_FILE_CREATION = true;

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
  const fileUri = vscode.Uri.joinPath(workspaceUri, '.projectCreator', USER_INSTRUCTIONS_FILE);
  try {
    const data = await vscode.workspace.fs.readFile(fileUri);
    const raw = new TextDecoder().decode(data).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function openPanel(context: vscode.ExtensionContext): void {
  if (currentPanel) {
    if (!currentPanel.visible) currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    viewType,
    'Project Creator',
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
        let history = message.messages ?? [];
        const noContext = message.noProjectContext === true;
        const userInstructions = currentWorkspaceUri ? await readUserInstructionsFromWorkspace(currentWorkspaceUri) : null;
        const projectContext =
          !noContext && currentWorkspaceUri
            ? await getFinderProjectContext(currentWorkspaceUri, getActiveFileRelative(currentWorkspaceUri), message.text)
            : null;
        const len = !noContext ? (projectContext?.length ?? 0) : 0;
        if (!noContext) console.log('[ProjectCreator] Контекст проекта:', len ? `${len} символов` : 'нет');
        panel.webview.postMessage({ type: 'projectContextUsed', chars: len });
        const systemContent = getSystemPrompt(!noContext, userInstructions, projectContext);
        const config = getLLMConfig();
        const contextLimit = config?.contextWindow ?? 128000;
        const promptText = systemContent + history.map((m) => m.text).join('') + message.text;
        let estimatedTokens = estimateTokens(promptText);
        if (estimatedTokens > contextLimit * CONTEXT_COMPRESS_THRESHOLD && history.length > 0) {
          const toCompress = history.map((m) => `${m.role}: ${m.text}`).join('\n\n');
          const summaryResult = await chat([
            { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
            { role: 'user', content: toCompress },
          ]);
          const summary = summaryResult.content?.trim() ?? '';
          history = [{ role: 'user', text: '[Контекст сжат]\n' + summary }];
          panel.webview.postMessage({ type: 'replaceHistory', chatId, messages: history });
        }
        panel.webview.postMessage({
          type: 'userMessage',
          text: message.text,
          chatId,
        });
        const llmMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
          { role: 'system', content: systemContent },
          ...history.map((m) => ({
            role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: m.text,
          })),
        ];
        llmMessages.push({ role: 'user', content: message.text });
        chatWithTools(llmMessages, currentWorkspaceUri, {
          onToolProgress: (toolName) => safePostMessage(panel, { type: 'toolProgress', tool: toolName, chatId }),
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
              estimateTokens(systemContent + history.map((m) => m.text).join('') + message.text + content);
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
            const text = err?.message?.includes('504') ? 'Таймаут (504 Gateway Time-out). Увеличьте таймаут прокси или повторите позже.' : String(err?.message ?? err);
            safePostMessage(panel, {
              type: 'assistantMessage',
              text,
              chatId,
              isError: true,
              contextUsed: 0,
              contextLimit: config?.contextWindow ?? 128000,
              toolsUsed: [],
            });
          });
        return;
      }
      if (message.type === 'retry' && message.chatId && Array.isArray(message.messages)) {
        const chatId = message.chatId;
        const messages = message.messages as { role: string; text: string }[];
        if (messages.length === 0) return;
        const last = messages[messages.length - 1];
        const history = messages.slice(0, -1);
        const noContext = message.noProjectContext === true;
        const userInstructions = currentWorkspaceUri ? await readUserInstructionsFromWorkspace(currentWorkspaceUri) : null;
        const lastText = typeof last?.text === 'string' ? last.text : '';
        const projectContext =
          !noContext && currentWorkspaceUri
            ? await getFinderProjectContext(currentWorkspaceUri, getActiveFileRelative(currentWorkspaceUri), lastText)
            : null;
        const lenRetry = !noContext ? (projectContext?.length ?? 0) : 0;
        if (!noContext) console.log('[ProjectCreator] Контекст проекта (retry):', lenRetry ? `${lenRetry} символов` : 'нет');
        safePostMessage(panel, { type: 'projectContextUsed', chars: lenRetry });
        const systemContent = getSystemPrompt(!noContext, userInstructions, projectContext);
        const config = getLLMConfig();
        const contextLimit = config?.contextWindow ?? 128000;
        const llmMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
          { role: 'system', content: systemContent },
          ...history.map((m) => ({
            role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: m.text,
          })),
        ];
        llmMessages.push({ role: 'user', content: last.text });
        chatWithTools(llmMessages, currentWorkspaceUri, {
          onToolProgress: (toolName) => safePostMessage(panel, { type: 'toolProgress', tool: toolName, chatId }),
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
              estimateTokens(systemContent + history.map((m) => m.text).join('') + last.text + content);
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
            const text = err?.message?.includes('504') ? 'Таймаут (504 Gateway Time-out). Увеличьте таймаут прокси или повторите позже.' : String(err?.message ?? err);
            safePostMessage(panel, {
              type: 'assistantMessage',
              text,
              chatId,
              isError: true,
              contextUsed: 0,
              contextLimit: config?.contextWindow ?? 128000,
              toolsUsed: [],
            });
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
        if (DISABLE_LLM_FILE_CREATION) return;
        if (!currentWorkspaceUri) return;
        const toApply = lastProposedEditsByChat[message.chatId];
        if (!toApply?.length) return;
        delete lastProposedEditsByChat[message.chatId];
        Promise.all(
          toApply.map((e) =>
            vscode.workspace.fs.writeFile(
              vscode.Uri.joinPath(currentWorkspaceUri, e.path.replace(/\\/g, '/')),
              new TextEncoder().encode(e.content)
            )
          )
        )
          .then(() => {
            safePostMessage(panel, { type: 'diffApplied' });
          })
          .catch((err) => {
            console.error('[ProjectCreator] applyEdits failed:', err);
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
