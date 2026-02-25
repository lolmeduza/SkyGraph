import { ToolHandler } from '../types';
import { getIndex } from '../../../context/indexer';

const MAX_SEARCH_RESULTS = 30;

// Сегменты пути, которые указывают на вторичные/сгенерированные копии исходников.
// Файлы с этими сегментами получают штраф и опускаются ниже в результатах.
const DEPRIORITIZED_SEGMENTS = [
  'static-react',
  'static',
  'legacy',
  '/dist/',
  '/build/',
  '/generated/',
  '/__generated__/',
  '/.cache/',
  '/node_modules/',
];

function searchPenalty(lower: string): number {
  return DEPRIORITIZED_SEGMENTS.reduce(
    (acc, seg) => acc + (lower.includes(seg) ? 1 : 0),
    0
  );
}

export const searchFilesHandler: ToolHandler = {
  name: 'search_files',
  description:
    'Поиск файлов проекта по ключевым словам в путях и именах файлов. Возвращает список путей. Исходные src/ файлы идут первыми.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Ключевые слова для поиска (например "seller stats", "login form")',
      },
    },
    required: ['query'],
  },
  async execute(args, workspaceUri) {
    const query = String(args.query ?? '');
    if (!query.trim()) return 'Пустой запрос';

    const index = await getIndex(workspaceUri);
    if (!index) return 'Индекс не найден';

    const tokens = query.toLowerCase().split(/[\s/\\_\-.]+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) return 'Нет ключевых слов';

    const scored: { path: string; score: number; penalty: number }[] = [];
    for (const rel of Object.keys(index.files)) {
      const lower = rel.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (lower.includes(t)) score++;
      }
      if (score > 0) scored.push({ path: rel, score, penalty: searchPenalty(lower) });
    }

    // Сортируем: сначала по штрафу (меньше = лучше), потом по очкам (больше = лучше)
    scored.sort((a, b) => {
      if (a.penalty !== b.penalty) return a.penalty - b.penalty;
      return b.score - a.score;
    });
    const top = scored.slice(0, MAX_SEARCH_RESULTS);
    if (top.length === 0) return 'Файлы не найдены';

    return top.map((r) => r.path).join('\n');
  },
};
