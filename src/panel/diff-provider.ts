import * as vscode from 'vscode';

const SCHEME = 'skygraph-original';

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  set(filePath: string, content: string): vscode.Uri {
    const key = encodeURIComponent(filePath);
    this.store.set(key, content);
    const uri = vscode.Uri.parse(`${SCHEME}:${key}`);
    this._onDidChange.fire(uri);
    return uri;
  }

  delete(filePath: string): void {
    const key = encodeURIComponent(filePath);
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.path) ?? '';
  }
}

const provider = new DiffContentProvider();

export function registerDiffProvider(context: vscode.ExtensionContext): void {
  const disposable = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  context.subscriptions.push(disposable);
}

/**
 * Сохраняет оригинальное содержимое файла и возвращает URI для левой панели diff.
 */
export function setOriginal(filePath: string, content: string): vscode.Uri {
  return provider.set(filePath, content);
}

export function clearOriginals(): void {
  provider.clear();
}

/**
 * Открывает нативный VSCode diff editor для одного файла.
 * originalContent — содержимое до правки (левая панель).
 * modifiedUri — URI реального файла с уже записанным новым содержимым (правая панель).
 */
export async function openDiff(
  filePath: string,
  originalContent: string,
  modifiedUri: vscode.Uri
): Promise<void> {
  const originalUri = setOriginal(filePath, originalContent);
  const label = `SkyGraph: ${filePath.split('/').pop() ?? filePath}`;
  await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, label, {
    preview: true,
    viewColumn: vscode.ViewColumn.One,
  });
}
