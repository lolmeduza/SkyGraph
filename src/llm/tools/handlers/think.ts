import { ToolHandler } from '../types';

/**
 * Инструмент "думания вслух" — LLM вызывает его как первый шаг перед сложными решениями.
 * Результат не показывается пользователю напрямую, но идёт обратно в контекст LLM.
 * В UI отображается отдельно как collapsible "Рассуждение".
 */
export const thinkHandler: ToolHandler = {
  name: 'think',
  description:
    'Инструмент для рассуждения перед принятием сложного решения. ' +
    'Используй как ПЕРВЫЙ шаг когда задача неоднозначная, требует анализа архитектуры или затрагивает несколько файлов. ' +
    'Пиши свои мысли честно: что понял, что неясно, какой план, какие риски. ' +
    'НЕ используй для простых вопросов и поиска.',
  parameters: {
    type: 'object',
    properties: {
      reasoning: {
        type: 'string',
        description: 'Твои мысли вслух: анализ задачи, план действий, риски, вопросы.',
      },
    },
    required: ['reasoning'],
  },
  async execute(args): Promise<string> {
    const reasoning = String(args.reasoning ?? '').trim();
    if (!reasoning) return 'Рассуждение пустое.';
    console.log(`[SkyGraph] Think: ${reasoning.slice(0, 200)}${reasoning.length > 200 ? '...' : ''}`);
    // Возвращаем structured ответ — LLM видит подтверждение, UI может распарсить тег
    return `<think_result>\n${reasoning}\n</think_result>\nРассуждение зафиксировано. Продолжай с инструментами.`;
  },
};
