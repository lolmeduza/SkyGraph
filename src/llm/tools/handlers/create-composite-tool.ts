import { ToolHandler } from '../types';
import { register, getAllHandlers } from '../registry';

export const createCompositeToolHandler: ToolHandler = {
  name: 'create_composite_tool',
  description:
    'Создать новый составной инструмент из комбинации существующих. Инструмент будет доступен для использования в этой сессии. ' +
    'Пример: создать "find_and_analyze" который ищет файлы, читает их и анализирует паттерны.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Имя нового инструмента (snake_case)',
      },
      description: {
        type: 'string',
        description: 'Описание что делает инструмент',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'Имя существующего инструмента для вызова',
            },
            args: {
              type: 'object',
              description: 'Аргументы для инструмента (можно использовать ${prev_result} для результата предыдущего шага)',
            },
          },
          required: ['tool', 'args'],
        },
        description: 'Последовательность шагов (вызовов существующих инструментов)',
      },
    },
    required: ['name', 'description', 'steps'],
  },
  async execute(args) {
    const name = String(args.name ?? '');
    const description = String(args.description ?? '');
    const steps = args.steps;

    if (!name || !description || !Array.isArray(steps) || steps.length === 0) {
      return 'Ошибка: нужны name, description и steps (массив)';
    }

    // Валидация: проверяем что все инструменты существуют
    const allHandlers = getAllHandlers();
    const handlerMap = new Map(allHandlers.map((h) => [h.name, h]));

    for (const step of steps) {
      if (!step || typeof step !== 'object') {
        return 'Ошибка: каждый step должен быть объектом {tool, args}';
      }
      const toolName = String((step as { tool?: unknown }).tool ?? '');
      if (!handlerMap.has(toolName)) {
        return `Ошибка: инструмент "${toolName}" не существует. Доступные: ${Array.from(handlerMap.keys()).join(', ')}`;
      }
    }

    // Создаём новый handler
    const newHandler: ToolHandler = {
      name,
      description: `[Составной инструмент] ${description}`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Входные данные для инструмента',
          },
        },
        required: [],
      },
      async execute(execArgs, execWorkspaceUri) {
        const results: string[] = [];
        let prevResult = String(execArgs.query ?? '');

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i] as { tool: string; args: Record<string, unknown> };
          const handler = handlerMap.get(step.tool);
          if (!handler) continue;

          // Заменяем ${prev_result} на результат предыдущего шага
          const resolvedArgs: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(step.args)) {
            if (typeof value === 'string' && value.includes('${prev_result}')) {
              resolvedArgs[key] = value.replace('${prev_result}', prevResult);
            } else if (typeof value === 'string' && value.includes('${query}')) {
              resolvedArgs[key] = value.replace('${query}', String(execArgs.query ?? ''));
            } else {
              resolvedArgs[key] = value;
            }
          }

          try {
            const result = await handler.execute(resolvedArgs, execWorkspaceUri);
            const resultStr = typeof result === 'string' ? result : result.result;
            results.push(`Шаг ${i + 1} (${step.tool}): ${resultStr.slice(0, 500)}${resultStr.length > 500 ? '...' : ''}`);
            prevResult = resultStr;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Ошибка на шаге ${i + 1} (${step.tool}): ${msg}`;
          }
        }

        return `Составной инструмент "${name}" выполнен:\n\n${results.join('\n\n')}\n\nФинальный результат:\n${prevResult}`;
      },
    };

    // Регистрируем новый инструмент
    register(newHandler);

    return `✅ Создан новый инструмент "${name}"!\n\nОписание: ${description}\n\nШаги: ${steps.map((s, i) => `${i + 1}. ${(s as { tool: string }).tool}`).join(', ')}\n\nТеперь ты можешь использовать его как обычный инструмент.`;
  },
};
