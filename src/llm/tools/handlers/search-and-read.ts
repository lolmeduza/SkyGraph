import { ToolHandler } from '../types';
import { searchFilesHandler } from './search-files';
import { readFileHandler } from './read-file';

export const searchAndReadHandler: ToolHandler = {
  name: 'search_and_read',
  description:
    'Поиск файлов по запросу и чтение их содержимого (search_files + read_file по топ-N). Удобно для быстрого контекста.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Ключевые слова для поиска',
      },
      maxFiles: {
        type: 'number',
        description: 'Сколько файлов прочитать (по умолчанию 5)',
      },
    },
    required: ['query'],
  },
  async execute(args, workspaceUri) {
    const query = String(args.query ?? '');
    const maxFiles = typeof args.maxFiles === 'number' ? args.maxFiles : 5;

    // Используем search_files
    const searchResult = await searchFilesHandler.execute({ query }, workspaceUri);
    if (typeof searchResult !== 'string') return 'Ошибка поиска файлов';
    
    if (
      searchResult.startsWith('Пустой') ||
      searchResult.startsWith('Индекс') ||
      searchResult.startsWith('Нет') ||
      searchResult.startsWith('Файлы не найдены')
    ) {
      return searchResult;
    }

    const paths = searchResult.split('\n').slice(0, Math.max(1, Math.min(maxFiles, 10)));
    const parts: string[] = [];

    // Читаем каждый файл
    for (const p of paths) {
      const content = await readFileHandler.execute({ path: p.trim() }, workspaceUri);
      if (typeof content !== 'string') continue;
      parts.push(`=== ${p} ===\n${content}`);
    }

    return parts.join('\n\n');
  },
};
