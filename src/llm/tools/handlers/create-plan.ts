import { ToolHandler } from '../types';

export interface PlanStep {
  file: string;
  action: 'modify' | 'create' | 'delete' | 'rename';
  description: string;
  /** Новый путь при rename */
  newFile?: string;
}

export interface PlanData {
  title: string;
  steps: PlanStep[];
  notes?: string;
}

export const createPlanHandler: ToolHandler = {
  name: 'create_plan',
  description:
    'Создать структурированный план изменений перед выполнением большой задачи. ' +
    'ОБЯЗАТЕЛЕН когда: задача затрагивает 3+ файла, миграция технологий, ' +
    'большой рефакторинг, переписывание компонентов. ' +
    'После подтверждения пользователем выполняй шаги последовательно через propose_edits.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Название задачи ()',
      },
      steps: {
        type: 'array',
        description: 'Шаги плана — каждый шаг один файл',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Путь к файлу' },
            action: {
              type: 'string',
              enum: ['modify', 'create', 'delete', 'rename'],
              description: 'Действие с файлом',
            },
            description: {
              type: 'string',
              description: 'Что именно делать с этим файлом',
            },
            newFile: {
              type: 'string',
              description: 'Новый путь (только для action: rename)',
            },
          },
          required: ['file', 'action', 'description'],
        },
      },
      notes: {
        type: 'string',
        description: 'Дополнительные замечания: зависимости, риски, что нужно проверить',
      },
    },
    required: ['title', 'steps'],
  },
  async execute(args): Promise<string> {
    const title = String(args.title ?? '').trim();
    const steps = Array.isArray(args.steps) ? args.steps as PlanStep[] : [];
    const notes = args.notes ? String(args.notes).trim() : undefined;

    if (!title) return 'Ошибка: title обязателен.';
    if (steps.length === 0) return 'Ошибка: steps не может быть пустым.';

    const plan: PlanData = { title, steps, notes };

    console.log(`[SkyGraph] Plan created: "${title}", ${steps.length} steps`);

    // Возвращаем JSON плана в теге — panel/index.ts его перехватит
    return `<plan_result>\n${JSON.stringify(plan)}\n</plan_result>\nПлан создан. Жду подтверждения пользователя.`;
  },
};
