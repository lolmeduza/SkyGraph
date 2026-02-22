import * as vscode from 'vscode';
import * as path from 'path';
import { getProjectCommands } from './project-commands';

export interface EditItem {
  path: string;
  content: string;
}

export interface RunValidationOptions {
  commands?: string[];
}

const VALIDATE_TIMEOUT_MS = 60000;
const MAX_BUFFER = 2 * 1024 * 1024;

function filterTscOutputToEditedFiles(fullOutput: string, editedPaths: string[]): string {
  const normalized = editedPaths.map((p) => p.replace(/\\/g, '/'));
  const lines = fullOutput.split('\n');
  const kept = lines.filter((line) => {
    const lineNorm = line.replace(/\\/g, '/');
    return normalized.some((p) => lineNorm.includes(p));
  });
  return kept.join('\n').trim();
}

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

export async function runValidation(
  workspaceUri: vscode.Uri,
  edits: EditItem[],
  options?: RunValidationOptions
): Promise<{ output: string; hasErrors: boolean }> {
  if (edits.length === 0) return { output: '', hasErrors: false };

  const root = workspaceUri.fsPath;
  const paths = edits.map((e) => e.path.replace(/\\/g, '/'));
  console.log('[ProjectCreator] Валидация: подмена', paths.length, 'файлов:', paths.join(', '));

  const backups: { path: string; content: Uint8Array; existed: boolean }[] = [];

  try {
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
    let commandsToRun: string[] | null = null;

    if (options?.commands?.length) {
      commandsToRun = options.commands;
      console.log('[ProjectCreator] Валидация: команды от LLM', commandsToRun.length);
    } else {
      const discovered = await getProjectCommands(workspaceUri);
      if (discovered.all.length) {
        commandsToRun = discovered.all;
        console.log('[ProjectCreator] Валидация: команды из проекта', commandsToRun.join(', '));
      }
    }

    if (commandsToRun?.length) {
      for (const cmd of commandsToRun) {
        console.log('[ProjectCreator] Валидация: запуск', cmd);
        const { output, failed } = await runOneCommand(root, cmd);
        if (failed || output) {
          parts.push(`--- ${cmd} ---\n${output}`);
          if (failed) hasErrors = true;
        }
      }
    } else {
      const fs = await import('fs/promises');
      const tsconfig = path.join(root, 'tsconfig.json');
      let hasTsc = false;
      try {
        await fs.access(tsconfig);
        hasTsc = true;
      } catch {
        // no tsconfig
      }
      if (hasTsc) {
        console.log('[ProjectCreator] Валидация: запуск tsc --noEmit');
        try {
          const { execSync: run } = await import('child_process');
          const out = run('npx tsc --noEmit 2>&1', {
            cwd: root,
            encoding: 'utf-8',
            timeout: VALIDATE_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
          });
          const raw = out ? String(out).trim() : '';
          const filtered = raw ? filterTscOutputToEditedFiles(raw, paths) : '';
          if (filtered) {
            parts.push('--- tsc (только изменённые файлы) ---\n' + filtered);
            hasErrors = true;
            console.log('[ProjectCreator] Валидация: tsc — ошибки в изменённых файлах,', filtered.length, 'симв.');
          } else if (raw) {
            console.log('[ProjectCreator] Валидация: tsc — ошибки есть в проекте, но не в изменённых файлах');
          } else {
            console.log('[ProjectCreator] Валидация: tsc — ок');
          }
        } catch (err: unknown) {
          const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
          const stdout = err && typeof err === 'object' && 'stdout' in err ? String((err as { stdout?: unknown }).stdout) : '';
          const msg = err instanceof Error ? err.message : String(err);
          const out = [stdout, stderr, msg].filter(Boolean).join('\n').trim();
          if (out) {
            const filtered = filterTscOutputToEditedFiles(out, paths);
            if (filtered) {
              parts.push('--- tsc (только изменённые файлы) ---\n' + filtered);
              hasErrors = true;
            }
            console.log('[ProjectCreator] Валидация: tsc — ошибка, в изменённых:', !!filtered);
          }
        }
      }

      const hasGo = edits.some((e) => e.path.replace(/\\/g, '/').endsWith('.go'));
      if (hasGo) {
        console.log('[ProjectCreator] Валидация: запуск go build ./...');
        try {
          const { execSync: run } = await import('child_process');
          run('go build ./... 2>&1', {
            cwd: root,
            encoding: 'utf-8',
            timeout: VALIDATE_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
          });
          console.log('[ProjectCreator] Валидация: go build — ок');
        } catch (err: unknown) {
          const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
          const stdout = err && typeof err === 'object' && 'stdout' in err ? String((err as { stdout?: unknown }).stdout) : '';
          const msg = err instanceof Error ? err.message : String(err);
          const out = [stdout, stderr, msg].filter(Boolean).join('\n').trim();
          if (out) {
            parts.push('--- go build ---\n' + out);
            hasErrors = true;
            console.log('[ProjectCreator] Валидация: go build — ошибки,', out.slice(0, 150));
          }
        }
      }

      const eslintPaths = edits
        .filter((e) => /\.(tsx?|jsx?|vue|js|mjs|cjs)$/i.test(e.path))
        .map((e) => e.path.replace(/\\/g, '/'));
      if (eslintPaths.length > 0) {
        console.log('[ProjectCreator] Валидация: запуск eslint для', eslintPaths.length, 'файлов');
        try {
          const { execSync: run } = await import('child_process');
          const out = run(`npx eslint ${eslintPaths.map((p) => JSON.stringify(p)).join(' ')} 2>&1`, {
            cwd: root,
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          });
          if (out && String(out).trim()) {
            parts.push('--- eslint ---\n' + String(out).trim());
            hasErrors = true;
            console.log('[ProjectCreator] Валидация: eslint — ошибки,', String(out).trim().length, 'симв.');
          } else {
            console.log('[ProjectCreator] Валидация: eslint — ок');
          }
        } catch (err: unknown) {
          const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
          const stdout = err && typeof err === 'object' && 'stdout' in err ? String((err as { stdout?: unknown }).stdout) : '';
          const msg = err instanceof Error ? err.message : String(err);
          const out = [stdout, stderr, msg].filter(Boolean).join('\n').trim();
          if (out) {
            parts.push('--- eslint ---\n' + out);
            hasErrors = true;
            console.log('[ProjectCreator] Валидация: eslint — ошибка,', out.slice(0, 150));
          }
        }
      }
    }

    const output = parts.join('\n\n').trim();
    console.log('[ProjectCreator] Валидация: результат —', hasErrors ? `ошибки (${output.length} симв.)` : 'ок');
    return { output, hasErrors };
  } finally {
    console.log('[ProjectCreator] Валидация: восстановление', backups.length, 'файлов');
    for (const b of backups) {
      const uri = vscode.Uri.joinPath(workspaceUri, b.path);
      try {
        if (b.existed) {
          await vscode.workspace.fs.writeFile(uri, b.content);
        } else {
          await vscode.workspace.fs.delete(uri);
        }
      } catch (e) {
        console.error('[ProjectCreator] Restore failed:', b.path, e);
      }
    }
  }
}
