import * as vscode from 'vscode';
import { getIndex } from '../context/indexer';
import { runValidation } from '../validation/run-validation';
import { getProjectCommands } from '../validation/project-commands';
import { LLMToolCall } from './types';

export interface ToolResultWithDiff {
  result: string;
  diffPayload?: { files: { path: string; originalContent: string; proposedContent: string }[] };
}

export interface ToolContext {
  proposeEditsAttempt?: number;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolHandler {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, workspaceUri: vscode.Uri, context?: ToolContext): Promise<string | ToolResultWithDiff>;
}

const registry = new Map<string, ToolHandler>();

function register(handler: ToolHandler): void {
  registry.set(handler.definition.function.name, handler);
}

function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((h) => h.definition);
}

const def = (name: string, description: string, parameters: Record<string, unknown>) =>
  ({ type: 'function' as const, function: { name, description, parameters } });

register({
  definition: def('search_files', 'Поиск файлов проекта по ключевым словам в путях и именах файлов. Возвращает список путей.', {
    type: 'object',
    properties: { query: { type: 'string', description: 'Ключевые слова для поиска (например "seller stats", "login form")' } },
    required: ['query'],
  }),
  execute: (args, uri) => toolSearchFiles(String(args.query ?? ''), uri),
});

register({
  definition: def('read_file', 'Прочитать содержимое файла по относительному пути.', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Относительный путь к файлу (например "src/pages/Home.vue")' } },
    required: ['path'],
  }),
  execute: (args, uri) => toolReadFile(String(args.path ?? ''), uri),
});

register({
  definition: def('grep', 'Поиск текста/regex внутри файлов проекта. Возвращает совпадения с путями и строками.', {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Текст или regex для поиска' },
      glob: { type: 'string', description: 'Glob-фильтр файлов (например "**/*.ts"). По умолчанию все файлы.' },
    },
    required: ['pattern'],
  }),
  execute: (args, uri) => toolGrep(String(args.pattern ?? ''), args.glob != null ? String(args.glob) : undefined, uri),
});

register({
  definition: def('get_project_commands', 'Узнать, какие команды в проекте для lint/build/test (из package.json, go.mod и т.д.). Результат можно передать в validation_commands при propose_edits.', { type: 'object', properties: {}, required: [] }),
  execute: async (_args, uri) => {
    const cmds = await getProjectCommands(uri);
    const lines: string[] = [];
    if (cmds.lint.length) lines.push('lint: ' + cmds.lint.join(', '));
    if (cmds.build.length) lines.push('build: ' + cmds.build.join(', '));
    if (cmds.test.length) lines.push('test: ' + cmds.test.join(', '));
    if (lines.length === 0) return 'Команды не обнаружены (нет package.json/go.mod/pyproject.toml с типичными скриптами).';
    return lines.join('\n') + '\n\nДля проверки правок используй эти команды в propose_edits (validation_commands).';
  },
});

register({
  definition: def('search_and_read', 'Поиск файлов по запросу и чтение их содержимого (search_files + read_file по топ-N). Удобно для быстрого контекста.', {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Ключевые слова для поиска' },
      maxFiles: { type: 'number', description: 'Сколько файлов прочитать (по умолчанию 5)' },
    },
    required: ['query'],
  }),
  execute: (args, uri) => toolSearchAndRead(String(args.query ?? ''), typeof args.maxFiles === 'number' ? args.maxFiles : 5, uri),
});

register({
  definition: def('propose_edits', 'Предложить правки в файлах. edits: [{ path, content }]. Опционально validation_commands: массив команд для проверки (из get_project_commands). Без него — автоопределение по проекту. Максимум 5 попыток.', {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        description: 'Список правок',
      },
      validation_commands: { type: 'array', items: { type: 'string' }, description: 'Команды для проверки (например из get_project_commands)' },
    },
    required: ['edits'],
  }),
  execute: (args, uri, ctx) => toolProposeEdits(args, uri, ctx),
});

export const TOOLS: ToolDefinition[] = getToolDefinitions();

const MAX_FILE_CHARS = 12000;
const MAX_SEARCH_RESULTS = 30;
const MAX_GREP_RESULTS = 25;

export async function executeTool(
  call: LLMToolCall,
  workspaceUri: vscode.Uri,
  context?: ToolContext
): Promise<string | ToolResultWithDiff> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return 'Ошибка: невалидный JSON аргументов';
  }
  const name = call.function.name;
  console.log(`[ProjectCreator] Tool call: ${name}(${call.function.arguments})`);
  const handler = registry.get(name);
  if (!handler) return `Неизвестный инструмент: ${name}`;
  try {
    return await handler.execute(args, workspaceUri, context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ProjectCreator] Tool error (${name}):`, msg);
    return `Ошибка: ${msg}`;
  }
}

async function toolProposeEdits(
  args: Record<string, unknown>,
  workspaceUri: vscode.Uri,
  context?: ToolContext
): Promise<string | ToolResultWithDiff> {
  const attempt = context?.proposeEditsAttempt ?? 0;
  if (attempt >= 5) {
    return 'Достигнут лимит попыток (5). Примени правки вручную или упрости изменения.';
  }
  const raw = args.edits;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'Ожидается массив edits: [{ path, content }].';
  }
  const edits: { path: string; content: string }[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && 'path' in item && 'content' in item) {
      const path = String((item as { path: unknown }).path).replace(/\\/g, '/');
      const content = typeof (item as { content: unknown }).content === 'string' ? (item as { content: string }).content : String((item as { content: unknown }).content);
      edits.push({ path, content });
    }
  }
  if (edits.length === 0) return 'Нет валидных правок в edits.';

  const originals: { path: string; originalContent: string; proposedContent: string }[] = [];
  for (const e of edits) {
    const uri = vscode.Uri.joinPath(workspaceUri, e.path);
    let originalContent = '';
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      originalContent = new TextDecoder().decode(data);
    } catch {
      // new file
    }
    originals.push({ path: e.path, originalContent, proposedContent: e.content });
  }

  const validationCommands = Array.isArray(args.validation_commands)
    ? args.validation_commands.filter((c): c is string => typeof c === 'string')
    : undefined;
  const { output, hasErrors } = await runValidation(workspaceUri, edits, validationCommands?.length ? { commands: validationCommands } : undefined);
  const result = hasErrors
    ? `Ошибки проверки (попытка ${attempt + 1}/5):\n\n${output}\n\nИсправь и вызови propose_edits снова.`
    : 'Проверка пройдена. Пользователь может применить правки.';
  console.log(
    '[ProjectCreator] propose_edits: попытка',
    attempt + 1,
    '/ 5 —',
    hasErrors ? `ошибки в LLM (${output.length} симв.)` : 'ок, diff показан'
  );
  return { result, diffPayload: { files: originals } };
}

async function toolSearchFiles(query: string, workspaceUri: vscode.Uri): Promise<string> {
  if (!query.trim()) return 'Пустой запрос';
  const index = await getIndex(workspaceUri);
  if (!index) return 'Индекс не найден';
  const tokens = query.toLowerCase().split(/[\s/\\_\-.]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return 'Нет ключевых слов';
  const scored: { path: string; score: number }[] = [];
  for (const rel of Object.keys(index.files)) {
    const lower = rel.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (lower.includes(t)) score++;
    }
    if (score > 0) scored.push({ path: rel, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_SEARCH_RESULTS);
  if (top.length === 0) return 'Файлы не найдены';
  return top.map((r) => r.path).join('\n');
}

async function toolSearchAndRead(query: string, maxFiles: number, workspaceUri: vscode.Uri): Promise<string> {
  const pathsStr = await toolSearchFiles(query, workspaceUri);
  if (pathsStr.startsWith('Пустой') || pathsStr.startsWith('Индекс') || pathsStr.startsWith('Нет') || pathsStr.startsWith('Файлы не найдены')) return pathsStr;
  const paths = pathsStr.split('\n').slice(0, Math.max(1, Math.min(maxFiles, 10)));
  const parts: string[] = [];
  for (const p of paths) {
    const content = await toolReadFile(p.trim(), workspaceUri);
    parts.push(`=== ${p} ===\n${content}`);
  }
  return parts.join('\n\n');
}

async function toolReadFile(filePath: string, workspaceUri: vscode.Uri): Promise<string> {
  if (!filePath.trim()) return 'Пустой путь';
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const uri = vscode.Uri.joinPath(workspaceUri, normalized);
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    const content = new TextDecoder().decode(data);
    if (content.length > MAX_FILE_CHARS) {
      return content.slice(0, MAX_FILE_CHARS) + `\n...(обрезано, всего ${content.length} символов)`;
    }
    return content;
  } catch {
    const resolved = await resolvePathFromIndex(normalized, workspaceUri);
    if (!resolved) return `Файл не найден: ${normalized}. Проверь путь или используй search_files.`;
    const resolvedUri = vscode.Uri.joinPath(workspaceUri, resolved);
    const data = await vscode.workspace.fs.readFile(resolvedUri);
    const content = new TextDecoder().decode(data);
    const out = content.length > MAX_FILE_CHARS
      ? content.slice(0, MAX_FILE_CHARS) + `\n...(обрезано, всего ${content.length} символов)`
      : content;
    return `Путь "${normalized}" не найден. Прочитан файл: ${resolved}\n\n${out}`;
  }
}

function resolvePathFromIndex(requestedPath: string, workspaceUri: vscode.Uri): Promise<string | null> {
  const segments = requestedPath.split('/').filter(Boolean);
  const filename = segments.pop() ?? requestedPath;
  const stem = filename.replace(/\.[^.]+$/, '');
  const dirPrefix = segments.join('/');
  return getIndex(workspaceUri).then((index) => {
    if (!index) return null;
    const paths = Object.keys(index.files);
    const exactName = paths.filter((p) => p.endsWith('/' + filename) || p === filename);
    const byStem = paths.filter((p) => {
      if (exactName.includes(p)) return false;
      const lower = p.toLowerCase();
      return (lower.includes('/' + stem.toLowerCase() + '/') || lower.endsWith('/' + stem.toLowerCase())) &&
        /\.(tsx?|jsx?|vue|go|py)$/i.test(p);
    });
    const candidates = [...exactName, ...byStem];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const aInDir = dirPrefix ? (a.startsWith(dirPrefix + '/') ? 0 : 1) : 0;
      const bInDir = dirPrefix ? (b.startsWith(dirPrefix + '/') ? 0 : 1) : 1;
      if (aInDir !== bInDir) return aInDir - bInDir;
      return a.split('/').length - b.split('/').length;
    });
    return candidates[0];
  });
}

async function toolGrep(pattern: string, glob: string | undefined, workspaceUri: vscode.Uri): Promise<string> {
  if (!pattern.trim()) return 'Пустой паттерн';
  const include = glob?.trim() || '**/*.{ts,tsx,js,jsx,vue,go,py}';
  const exclude = '{**/node_modules/**,**/vendor/**,**/dist/**,**/.nuxt/**,**/.git/**,**/out/**,**/.code-index/**}';
  const uris = await vscode.workspace.findFiles(include, exclude, 5000);
  const regex = new RegExp(pattern, 'gi');
  const results: string[] = [];
  for (const uri of uris) {
    if (results.length >= MAX_GREP_RESULTS) break;
    if (!uri.fsPath.startsWith(workspaceUri.fsPath)) continue;
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(data);
      const lines = text.split('\n');
      const rel = uri.fsPath.slice(workspaceUri.fsPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_GREP_RESULTS) break;
        if (regex.test(lines[i])) {
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          regex.lastIndex = 0;
        }
      }
    } catch { /* skip */ }
  }
  if (results.length === 0) return 'Совпадений не найдено';
  return results.join('\n');
}
