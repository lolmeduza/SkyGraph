import * as vscode from 'vscode';
import * as path from 'path';

export interface EditItem {
  path: string;
  content: string;
}

export interface RunValidationOptions {
  commands?: string[];
}

const VALIDATE_TIMEOUT_MS = 60000;
const MAX_BUFFER = 2 * 1024 * 1024;
const ENABLE_VALIDATION_COMMANDS = false;

async function runOneCommand(cwd: string, command: string): Promise<{ output: string; failed: boolean }> {
  try {
    const { execSync } = await import('child_process');
    const out = execSync(`${command} 2>&1`, {
      cwd,
      encoding: 'utf-8',
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const output = out ? String(out).trim() : '';
    return { output, failed: false };
  } catch (err: unknown) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
    const stdout = err && typeof err === 'object' && 'stdout' in err ? String((err as { stdout?: unknown }).stdout) : '';
    const msg = err instanceof Error ? err.message : String(err);
    const output = [stdout, stderr, msg].filter(Boolean).join('\n').trim();
    return { output, failed: true };
  }
}

function inferSubdirFromPaths(filePaths: string[]): string | null {
  if (filePaths.length === 0) return null;
  const roots = filePaths.map((p) => {
    const normalized = p.replace(/\\/g, '/').replace(/^\//, '');
    const firstSlash = normalized.indexOf('/');
    return firstSlash > 0 ? normalized.slice(0, firstSlash) : null;
  });
  const first = roots[0];
  if (first && roots.every((r) => r === first)) return first;
  return null;
}

export async function runValidation(
  workspaceUri: vscode.Uri,
  edits: EditItem[],
  options?: RunValidationOptions
): Promise<{ output: string; hasErrors: boolean }> {
  if (edits.length === 0) return { output: '', hasErrors: false };

  const root = workspaceUri.fsPath;
  const paths = edits.map((e) => e.path.replace(/\\/g, '/'));
  console.log('[SkyGraph] Валидация: подмена', paths.length, 'файлов:', paths.join(', '));

  const backups: { path: string; content: Uint8Array; existed: boolean }[] = [];

  try {
    // Backup + write
    for (const e of edits) {
      const normalized = e.path.replace(/\\/g, '/');
      const uri = vscode.Uri.joinPath(workspaceUri, normalized);
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        backups.push({ path: normalized, content: data, existed: true });
      } catch {
        backups.push({ path: normalized, content: new Uint8Array(0), existed: false });
        const parentPath = path.dirname(normalized);
        if (parentPath !== '.' && parentPath !== normalized) {
          try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceUri, parentPath));
          } catch { /* ignore */ }
        }
      }
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(e.content));
    }

    const parts: string[] = [];
    let hasErrors = false;

    if (options?.commands?.length && ENABLE_VALIDATION_COMMANDS) {
      console.log('[SkyGraph] Валидация: команды от LLM', options.commands.length);
      for (const cmd of options.commands) {
        console.log('[SkyGraph] Валидация: запуск', cmd);
        const { output, failed } = await runOneCommand(root, cmd);
        if (failed || output) {
          parts.push(`--- ${cmd} ---\n${output}`);
          if (failed) hasErrors = true;
        }
      }
    } else {
      // Ошибки видны через VSCode diagnostics (Problems) — запускать линтер не нужно
      if (options?.commands?.length && !ENABLE_VALIDATION_COMMANDS) {
        console.log('[SkyGraph] Валидация: запуск команд отключён флагом ENABLE_VALIDATION_COMMANDS=false');
      } else {
        console.log('[SkyGraph] Валидация: команды не переданы — пропускаем, ошибки видны через diagnostics');
      }
    }

    const output = parts.join('\n\n').trim();
    console.log('[SkyGraph] Валидация: результат —', hasErrors ? `ошибки (${output.length} симв.)` : 'ок');
    return { output, hasErrors };
  } finally {
    console.log('[SkyGraph] Валидация: восстановление', backups.length, 'файлов');
    for (const b of backups) {
      const uri = vscode.Uri.joinPath(workspaceUri, b.path);
      try {
        if (b.existed) {
          await vscode.workspace.fs.writeFile(uri, b.content);
        } else {
          await vscode.workspace.fs.delete(uri);
        }
      } catch (e) {
        console.error('[SkyGraph] Restore failed:', b.path, e);
      }
    }
  }
}

/**
 * Запускает validation_commands от LLM для уже применённых файлов — без backup/restore.
 * Если LLM не передал команды — ничего не запускаем (ошибки обновятся в VSCode diagnostics автоматически).
 */
export async function runValidationAfterApply(
  workspaceUri: vscode.Uri,
  edits: EditItem[],
  commands?: string[]
): Promise<{ output: string; hasErrors: boolean }> {
  if (edits.length === 0) return { output: '', hasErrors: false };

  const root = workspaceUri.fsPath;
  const paths = edits.map((e) => e.path.replace(/\\/g, '/'));
  console.log('[SkyGraph] Post-apply валидация:', paths.length, 'файлов:', paths.join(', '));

  if (!commands?.length || !ENABLE_VALIDATION_COMMANDS) {
    if (commands?.length && !ENABLE_VALIDATION_COMMANDS) {
      console.log('[SkyGraph] Post-apply: запуск команд отключён флагом ENABLE_VALIDATION_COMMANDS=false');
    }
    console.log('[SkyGraph] Post-apply: команды не переданы — пропускаем, ошибки обновятся в diagnostics');
    return { output: '', hasErrors: false };
  }

  const parts: string[] = [];
  let hasErrors = false;
  const subdir = inferSubdirFromPaths(paths);
  console.log('[SkyGraph] Post-apply: команды', subdir ? `(subdir: ${subdir})` : '(корень)', commands.join(', '));

  for (const cmd of commands) {
    console.log('[SkyGraph] Post-apply: запуск', cmd);
    const { output, failed } = await runOneCommand(root, cmd);
    if (failed || output) {
      parts.push(`--- ${cmd} ---\n${output}`);
      if (failed) hasErrors = true;
    }
  }

  const output = parts.join('\n\n').trim();
  console.log('[SkyGraph] Post-apply валидация: результат —', hasErrors ? `ошибки (${output.length} симв.)` : 'ок');
  return { output, hasErrors };
}
