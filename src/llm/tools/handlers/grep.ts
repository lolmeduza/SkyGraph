import * as vscode from 'vscode';
import { ToolHandler } from '../types';

const MAX_GREP_RESULTS = 25;

export const grepHandler: ToolHandler = {
  name: 'grep',
  description:
    'Поиск текста/regex внутри файлов. glob — маска файлов: **/*.ts (все .ts), **/*.json. contextLines — показать N строк до и после совпадения.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Текст или regex для поиска',
      },
      glob: {
        type: 'string',
        description: 'Маска файлов: **/*.ts или *.ts (по умолчанию **/*.{ts,tsx,js,jsx,vue,go,py})',
      },
      contextLines: {
        type: 'number',
        description: 'Число строк до и после совпадения (по умолчанию 0). Для поиска определений типов/функций используй 5-10.',
      },
    },
    required: ['pattern'],
  },
  async execute(args, workspaceUri) {
    const pattern = String(args.pattern ?? '');
    if (!pattern.trim()) return 'Пустой паттерн';

    const contextLines = typeof args.contextLines === 'number' ? Math.max(0, Math.min(args.contextLines, 20)) : 0;

    let include = args.glob ? String(args.glob).trim() : '**/*.{ts,tsx,js,jsx,vue,go,py}';
    if (!include.includes('**')) include = '**/' + include.replace(/^\/+/, '');

    const exclude =
      '{**/node_modules/**,**/vendor/**,**/dist/**,**/.nuxt/**,**/.git/**,**/out/**,**/.code-index/**}';
    const uris = await vscode.workspace.findFiles(include, exclude, 5000);
    const regex = new RegExp(pattern, 'gi');
    const results: string[] = [];
    const matchedLines = new Set<string>();

    for (const uri of uris) {
      if (results.length >= MAX_GREP_RESULTS) break;
      if (!uri.fsPath.startsWith(workspaceUri.fsPath)) continue;

      try {
        const data = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(data);
        const lines = text.split('\n');
        const rel = uri.fsPath
          .slice(workspaceUri.fsPath.length)
          .replace(/^[/\\]/, '')
          .replace(/\\/g, '/');

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_GREP_RESULTS) break;
          if (regex.test(lines[i])) {
            const key = `${rel}:${i + 1}`;
            if (matchedLines.has(key)) {
              regex.lastIndex = 0;
              continue;
            }
            matchedLines.add(key);

            if (contextLines === 0) {
              results.push(`${key}: ${lines[i].trim().slice(0, 200)}`);
            } else {
              const start = Math.max(0, i - contextLines);
              const end = Math.min(lines.length - 1, i + contextLines);
              const contextBlock: string[] = [`${rel}:${i + 1}:`];
              for (let j = start; j <= end; j++) {
                const prefix = j === i ? '> ' : '  ';
                contextBlock.push(`${prefix}${j + 1}| ${lines[j]}`);
              }
              results.push(contextBlock.join('\n'));
            }
            regex.lastIndex = 0;
          }
        }
      } catch {
        /* skip */
      }
    }

    if (results.length === 0) return 'Совпадений не найдено';
    return results.join('\n\n');
  },
};
