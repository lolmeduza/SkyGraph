import { ToolHandler, ToolResultWithDiff } from '../types';
import { runValidation } from '../../../validation/run-validation';
import { appendLLMMistake } from '../../../history';
import { readFileWithFallback } from './path-utils';

export const proposeEditsHandler: ToolHandler = {
  name: 'propose_edits',
  description:
    'Предложить правки в файлах. edits: [{ path, content }], content — одна JSON-строка (переносы как \\n, кавычки как \\"). validation_commands — опционально. Максимум 5 попыток.',
  parameters: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
        description: 'Список правок',
      },
      validation_commands: {
        type: 'array',
        items: { type: 'string' },
        description: 'Команды для проверки (например из get_project_commands)',
      },
    },
    required: ['edits'],
  },
  async execute(args, workspaceUri, context): Promise<string | ToolResultWithDiff> {
    const attempt = context?.proposeEditsAttempt ?? 0;
    if (attempt >= 5) {
      return 'Достигнут лимит попыток (5). Примени правки вручную или упрости изменения.';
    }

    const raw = args.edits;
    if (!Array.isArray(raw) || raw.length === 0) {
      return 'Ожидается массив edits: [{ path, content }].';
    }

    const edits: { path: string; content: string }[] = [];
    const suspiciousEdits: string[] = [];
    for (const item of raw) {
      if (item && typeof item === 'object' && 'path' in item && 'content' in item) {
        const filePath = String((item as { path: unknown }).path).replace(/\\/g, '/');
        const content =
          typeof (item as { content: unknown }).content === 'string'
            ? (item as { content: string }).content
            : String((item as { content: unknown }).content);

        // Отклоняем явно бессмысленный контент — заглушки вместо реального кода
        const trimmed = content.trim();
        const isJsonFile = filePath.endsWith('.json');
        const isPlaceholder =
          trimmed === '{}' ||
          trimmed === '[]' ||
          trimmed === '' ||
          (!isJsonFile && (trimmed === '{}' || trimmed === '[]'));
        if (isPlaceholder) {
          suspiciousEdits.push(filePath);
          continue;
        }

        edits.push({ path: filePath, content });
      }
    }

    if (suspiciousEdits.length > 0 && edits.length === 0) {
      return (
        `ОШИБКА: Контент для файлов [${suspiciousEdits.join(', ')}] содержит только заглушку ("{}"). ` +
        `Передай реальный полный код файла в поле content. Сначала прочитай файл через read_file, ` +
        `внеси изменения и отправь обновлённую версию.`
      );
    }
    if (suspiciousEdits.length > 0) {
      // Предупреждаем но продолжаем с остальными правками
      console.warn(`[SkyGraph] propose_edits: пропущены заглушки для ${suspiciousEdits.join(', ')}`);
    }

    if (edits.length === 0) return 'Нет валидных правок в edits.';

    const originals: { path: string; originalContent: string; proposedContent: string }[] = [];
    for (const e of edits) {
      const found = await readFileWithFallback(e.path, workspaceUri);
      const originalContent = found?.content ?? '';
      // Если путь разрешился иначе — используем разрешённый путь для диффа
      const resolvedPath = found?.resolvedPath ?? e.path;
      originals.push({ path: resolvedPath, originalContent, proposedContent: e.content });
    }

    const validationCommands = Array.isArray(args.validation_commands)
      ? args.validation_commands.filter((c): c is string => typeof c === 'string')
      : undefined;

    const { output, hasErrors } = await runValidation(
      workspaceUri,
      edits,
      validationCommands?.length ? { commands: validationCommands } : undefined
    );

    let result: string;
    if (hasErrors) {
      // При 2-й и последующих попытках — автоматически сохраняем паттерн ошибки
      if (attempt >= 1 && workspaceUri) {
        const workspacePath = workspaceUri.fsPath;
        // Берём первую значимую строку ошибки как паттерн
        const firstErrorLine = output
          .split('\n')
          .find((l) => {
            const t = l.trim();
            if (t.length <= 10 || t.startsWith('---')) return false;
            // Пропускаем бессмысленные строки (npm warn, oops, инфраструктурные)
            const lower = t.toLowerCase();
            if (lower.includes('oops') || lower.includes('something went wrong')) return false;
            if (lower.startsWith('npm warn') || lower.startsWith('npm notice')) return false;
            if (lower.includes('will be installed') || lower.includes('installing packages')) return false;
            return true;
          });
        if (firstErrorLine) {
          // Убираем конкретные пути/имена файлов чтобы паттерн был общим
          const pattern = firstErrorLine
            .replace(/['"][^'"]{3,}['"]/g, '"<value>"')
            .replace(/\b\w+\.(ts|tsx|js|jsx|go|py)\b/g, '<file>')
            .trim();
          appendLLMMistake(workspacePath, `Ошибка валидации (попытка ${attempt + 1}): ${pattern}`);
        }
      }

      const editsSummary = edits
        .map((e) => `### ${e.path}\n\`\`\`\n${e.content.slice(0, 600)}${e.content.length > 600 ? '\n... (truncated)' : ''}\n\`\`\``)
        .join('\n\n');
      result =
        `Ошибки проверки (попытка ${attempt + 1}/5):\n\n${output}\n\n` +
        `Твои правки которые были проверены (файлы откатились — используй их как основу для исправления):\n\n${editsSummary}\n\n` +
        `Прочитай эти версии, исправь ошибки и вызови propose_edits снова.`;
    } else {
      result = 'Проверка пройдена. Пользователь может применить правки.';
    }

    return { result, diffPayload: { files: originals } };
  },
};
