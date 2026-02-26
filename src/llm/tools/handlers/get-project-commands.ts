import { ToolHandler } from '../types';
import { getProjectCommands } from '../../../validation/project-commands';

export const getProjectCommandsHandler: ToolHandler = {
  name: 'get_project_commands',
  description:
    'Узнать, какие команды в проекте для lint/build/test (из package.json, go.mod и т.д.). ' +
    'Результат передай в validation_commands при propose_edits. ' +
    'Если package.json не в корне (например монорепо), передай subdir — путь к подпапке проекта (например "expr-builder").',
  parameters: {
    type: 'object',
    properties: {
      subdir: {
        type: 'string',
        description:
          'Относительный путь к подпапке проекта где лежит package.json (например "expr-builder", "frontend"). Пусто — ищет в корне.',
      },
    },
    required: [],
  },
  async execute(args, workspaceUri) {
    const subdir = args.subdir ? String(args.subdir).replace(/\\/g, '/').replace(/\/+$/, '') : undefined;
    const cmds = await getProjectCommands(workspaceUri, subdir);
    const lines: string[] = [];
    if (cmds.lint.length) lines.push('lint: ' + cmds.lint.join(', '));
    if (cmds.build.length) lines.push('build/typecheck: ' + cmds.build.join(', '));
    if (cmds.test.length) lines.push('test: ' + cmds.test.join(', '));
    if (lines.length === 0) {
      const hint = subdir
        ? `Команды не найдены в "${subdir}" и корне проекта. Попробуй другой subdir или передай команды вручную в validation_commands.`
        : 'Команды не обнаружены. Если package.json в подпапке, передай subdir (например "expr-builder").';
      return hint;
    }
    return (
      lines.join('\n') +
      '\n\nПередай нужные команды в propose_edits → validation_commands.'
    );
  },
};
