import * as vscode from 'vscode';
import { ToolHandler } from '../types';

export const listDirHandler: ToolHandler = {
  name: 'list_dir',
  description:
    'Список файлов и папок в директории проекта (один уровень). Используй когда нужно понять структуру папки перед чтением файлов.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Относительный путь к директории (например "src/components" или ""). Пустая строка — корень проекта.',
      },
    },
    required: ['path'],
  },
  async execute(args, workspaceUri) {
    const dirPath = String(args.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const uri = dirPath
      ? vscode.Uri.joinPath(workspaceUri, dirPath)
      : workspaceUri;

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return `Директория не найдена: ${dirPath || '(корень)'}`;
    }

    if (entries.length === 0) return `Директория пуста: ${dirPath || '(корень)'}`;

    entries.sort(([aName, aType], [bName, bType]) => {
      // Папки сначала
      const aIsDir = aType === vscode.FileType.Directory ? 0 : 1;
      const bIsDir = bType === vscode.FileType.Directory ? 0 : 1;
      if (aIsDir !== bIsDir) return aIsDir - bIsDir;
      return aName.localeCompare(bName);
    });

    const lines = entries.map(([name, type]) => {
      const prefix = type === vscode.FileType.Directory ? '[dir]  ' : '[file] ';
      const fullPath = dirPath ? `${dirPath}/${name}` : name;
      return `${prefix}${fullPath}`;
    });

    return lines.join('\n');
  },
};
