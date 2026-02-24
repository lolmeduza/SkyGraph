import { ToolHandler } from '../types';
import { getProjectCommands } from '../../../validation/project-commands';

export const getProjectCommandsHandler: ToolHandler = {
  name: 'get_project_commands',
  description:
    'Узнать, какие команды в проекте для lint/build/test (из package.json, go.mod и т.д.). Результат можно передать в validation_commands при propose_edits.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args, workspaceUri) {
    const cmds = await getProjectCommands(workspaceUri);
    const lines: string[] = [];
    if (cmds.lint.length) lines.push('lint: ' + cmds.lint.join(', '));
    if (cmds.build.length) lines.push('build: ' + cmds.build.join(', '));
    if (cmds.test.length) lines.push('test: ' + cmds.test.join(', '));
    if (lines.length === 0) {
      return 'Команды не обнаружены (нет package.json/go.mod/pyproject.toml с типичными скриптами).';
    }
    return (
      lines.join('\n') +
      '\n\nДля проверки правок используй эти команды в propose_edits (validation_commands).'
    );
  },
};
