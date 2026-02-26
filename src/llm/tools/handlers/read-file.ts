import * as vscode from 'vscode';
import { ToolHandler } from '../types';
import { resolvePathCandidates } from './path-utils';

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
      const candidates = await resolvePathCandidates(normalized, workspaceUri);
      if (candidates.length === 0) {
        return `Файл не найден: ${normalized}. Используй search_files или list_dir для проверки структуры.`;
      }
      const best = candidates[0];
      const resolvedUri = vscode.Uri.joinPath(workspaceUri, best);
      try {
        const data = await vscode.workspace.fs.readFile(resolvedUri);
        const fullContent = new TextDecoder().decode(data);
        const content = extractLines(fullContent, startLine, endLine);
        const out =
          content.length > MAX_FILE_CHARS
            ? content.slice(0, MAX_FILE_CHARS) + `\n...(обрезано, всего ${content.length} символов)`
            : content;
        const altHint =
          candidates.length > 1
            ? `\nДругие варианты: ${candidates.slice(1, 4).join(', ')}`
            : '';
        return `Путь "${normalized}" не найден. Прочитан: ${best}${altHint}\n\n${out}`;
      } catch {
        const list = candidates.slice(0, 5).join('\n  - ');
        return `Файл не найден: ${normalized}.\nВозможные совпадения:\n  - ${list}\nИспользуй read_file с одним из этих путей.`;
      }
    }
  },
};

