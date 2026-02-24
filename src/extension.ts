import * as vscode from 'vscode';
import * as fs from 'fs';
import { openPanel, getPanel } from './panel';
import { initLLM } from './llm';
import { getLLMConfig } from './llm/config';
import { ensureUserInstructionsPath } from './history';
import { getOrBuildIndex, updateIndex } from './context/indexer';
import { isIndexedFile } from './context/indexer/scanner';

const INDEX_DEBOUNCE_MS = 1500;
let indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;

let outputChannel: vscode.OutputChannel | null = null;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Sky Graph');
  }
  return outputChannel;
}

function appendToOutput(prefix: string, args: unknown[]): void {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  getOutputChannel().appendLine(prefix ? `${prefix} ${text}` : text);
}

function installOutputChannel(): void {
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (text.includes('[SkyGraph]')) {
      getOutputChannel().appendLine(text);
    }
  };

  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    appendToOutput('[ERROR]', args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    appendToOutput('[WARN]', args);
  };
}

function scheduleIndexUpdate(workspaceUri: vscode.Uri): void {
  if (indexDebounceTimer) clearTimeout(indexDebounceTimer);
  indexDebounceTimer = setTimeout(() => {
    indexDebounceTimer = null;
    void updateIndex(workspaceUri);
  }, INDEX_DEBOUNCE_MS);
}

export function activate(context: vscode.ExtensionContext): void {
  installOutputChannel();
  getOutputChannel().appendLine('[SkyGraph] Активация...');
  // Проверяем что патч console работает
  console.log('[SkyGraph] console.log патч работает');
  initLLM(getLLMConfig());

  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  getOutputChannel().appendLine('[SkyGraph] Workspace: ' + (workspaceUri?.fsPath ?? 'none'));
  
  if (workspaceUri) {
    void getOrBuildIndex(workspaceUri);
  }
  
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const panel = getPanel();
      if (!panel || !editor) return;
      const group = vscode.window.tabGroups.activeTabGroup;
      if (group.viewColumn === undefined || panel.viewColumn === undefined) return;
      if (group.viewColumn !== panel.viewColumn) return;
      void vscode.window.showTextDocument(editor.document.uri, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      }).then(() => {
        panel.reveal();
      });
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder || !isIndexedFile(doc.uri)) return;
      scheduleIndexUpdate(folder.uri);
    }),
    vscode.workspace.onDidCreateFiles((e) => {
      const wsUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!wsUri || !e.files.some((u) => isIndexedFile(u))) return;
      scheduleIndexUpdate(wsUri);
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      const wsUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!wsUri || !e.files.some((u) => isIndexedFile(u))) return;
      scheduleIndexUpdate(wsUri);
    }),
    vscode.commands.registerCommand('skyGraph.openPanel', () => {
      getOutputChannel().show(true);
      openPanel(context);
    }),
    vscode.commands.registerCommand('skyGraph.sendFileToLLM', () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      if (!doc?.uri) {
        vscode.window.showWarningMessage('Нет открытого файла.');
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder) {
        vscode.window.showWarningMessage('Файл не в рабочей области.');
        return;
      }
      const rel = vscode.workspace.asRelativePath(doc.uri).replace(/\\/g, '/');
      openPanel(context);
      const panel = getPanel();
      if (panel?.webview) {
        panel.reveal(vscode.ViewColumn.Beside);
        setTimeout(() => {
          getPanel()?.webview.postMessage({ type: 'insertFile', path: rel });
        }, 200);
      }
    }),
    vscode.commands.registerCommand('skyGraph.openUserInstructions', () => {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspacePath) {
        vscode.window.showWarningMessage('Откройте папку проекта.');
        return;
      }
      const filePath = ensureUserInstructionsPath(workspacePath);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf-8');
      }
      vscode.window.showTextDocument(vscode.Uri.file(filePath));
    }),
    vscode.commands.registerCommand('skyGraph.showOutput', () => {
      getOutputChannel().appendLine('[SkyGraph] Output opened by command.');
      getOutputChannel().show(true);
    })
  );
}

export function deactivate(): void {}