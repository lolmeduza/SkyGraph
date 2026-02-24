import * as vscode from 'vscode';
import { ToolHandler } from '../types';
import { getIndex } from '../../../context/indexer';

const MAX_FILE_CHARS = 12000;

function extractLines(content: string, startLine?: number, endLine?: number): string {
  if (!startLine && !endLine) return content;

  const lines = content.split('\n');
  const start = startLine ? Math.max(1, startLine) - 1 : 0;
  const end = endLine ? Math.min(lines.length, endLine) : lines.length;

  if (start >= lines.length) {
    return `Строка ${startLine} не существует. Файл содержит ${lines.length} строк.`;
  }

  const selected = lines.slice(start, end);
  const lineInfo = startLine || endLine 
    ? `Lines ${start + 1}–${end} из ${lines.length}:\n\n` 
    : '';
  
  return lineInfo + selected.join('\n');
}

export const readFileHandler: ToolHandler = {
  name: 'read_file',
  description: 'Прочитать содержимое файла по относительному пути. Для больших файлов можно указать диапазон строк.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Относительный путь к файлу (например "src/pages/Home.vue")',
      },
      startLine: {
        type: 'number',
        description: 'Начальная строка (1-indexed). Опционально — для чтения фрагмента большого файла.',
      },
      endLine: {
        type: 'number',
        description: 'Конечная строка включительно (1-indexed). Опционально — для чтения фрагмента.',
      },
    },
    required: ['path'],
  },
  async execute(args, workspaceUri) {
    const filePath = String(args.path ?? '');
    if (!filePath.trim()) return 'Пустой путь';

    const startLine = typeof args.startLine === 'number' && args.startLine > 0 ? Math.floor(args.startLine) : undefined;
    const endLine = typeof args.endLine === 'number' && args.endLine > 0 ? Math.floor(args.endLine) : undefined;

    const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
    const uri = vscode.Uri.joinPath(workspaceUri, normalized);

    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const fullContent = new TextDecoder().decode(data);
      const content = extractLines(fullContent, startLine, endLine);
      
      if (content.length > MAX_FILE_CHARS) {
        return content.slice(0, MAX_FILE_CHARS) + `\n...(обрезано, всего ${content.length} символов)`;
      }
      return content;
    } catch {
      const resolved = await resolvePathFromIndex(normalized, workspaceUri);
      if (!resolved) {
        return `Файл не найден: ${normalized}. Проверь путь или используй search_files.`;
      }
      const resolvedUri = vscode.Uri.joinPath(workspaceUri, resolved);
      const data = await vscode.workspace.fs.readFile(resolvedUri);
      const fullContent = new TextDecoder().decode(data);
      const content = extractLines(fullContent, startLine, endLine);
      const out =
        content.length > MAX_FILE_CHARS
          ? content.slice(0, MAX_FILE_CHARS) + `\n...(обрезано, всего ${content.length} символов)`
          : content;
      return `Путь "${normalized}" не найден. Прочитан файл: ${resolved}\n\n${out}`;
    }
  },
};

async function resolvePathFromIndex(
  requestedPath: string,
  workspaceUri: vscode.Uri
): Promise<string | null> {
  const segments = requestedPath.split('/').filter(Boolean);
  const filename = segments.pop() ?? requestedPath;
  const stem = filename.replace(/\.[^.]+$/, '');
  const dirPrefix = segments.join('/');

  const index = await getIndex(workspaceUri);
  if (!index) return null;

  const paths = Object.keys(index.files);
  const exactName = paths.filter((p) => p.endsWith('/' + filename) || p === filename);
  const byStem = paths.filter((p) => {
    if (exactName.includes(p)) return false;
    const lower = p.toLowerCase();
    return (
      (lower.includes('/' + stem.toLowerCase() + '/') ||
        lower.endsWith('/' + stem.toLowerCase())) &&
      /\.(tsx?|jsx?|vue|go|py)$/i.test(p)
    );
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
}
