import * as vscode from 'vscode';
import * as path from 'path';

export interface ProjectCommands {
  lint: string[];
  build: string[];
  test: string[];
  all: string[];
}

// Скрипты которые считаем lint/typecheck/build
const LINT_SCRIPTS = ['lint', 'eslint', 'eslint:fix', 'lint:fix', 'check', 'stylelint'];
const TYPE_SCRIPTS = ['typescript', 'typecheck', 'type-check', 'types', 'tsc'];
const BUILD_SCRIPTS = ['build', 'compile'];
const TEST_SCRIPTS = ['test', 'test:unit', 'test:ci', 'vitest', 'jest'];

async function findPackageJsonDirs(root: string, subdir?: string): Promise<string[]> {
  const fs = await import('fs/promises');
  const dirs: string[] = [];

  // Если указан subdir — проверяем его и его предков до root
  if (subdir) {
    let current = path.join(root, subdir);
    while (current.startsWith(root)) {
      try {
        await fs.access(path.join(current, 'package.json'));
        dirs.push(current);
        break; // Берём ближайший package.json вверх по дереву
      } catch { /* not found */ }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  // Всегда проверяем корень
  try {
    await fs.access(path.join(root, 'package.json'));
    if (!dirs.includes(root)) dirs.push(root);
  } catch { /* no package.json in root */ }

  // Ищем package.json в подпапках первого уровня (монорепо)
  if (dirs.length === 0) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name.startsWith('.') || name === 'node_modules') continue;
        const candidate = path.join(root, name);
        try {
          await fs.access(path.join(candidate, 'package.json'));
          dirs.push(candidate);
        } catch { /* not found */ }
      }
    } catch { /* readdir failed */ }
  }

  return dirs;
}

async function parsePackageJsonCommands(
  pkgDir: string,
  relDir: string
): Promise<{ lint: string[]; build: string[]; test: string[] }> {
  const fs = await import('fs/promises');
  const lint: string[] = [];
  const build: string[] = [];
  const test: string[] = [];

  try {
    const raw = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg?.scripts ?? {};

    const prefix = relDir ? `cd ${relDir} && ` : '';

    for (const name of Object.keys(scripts)) {
      const lower = name.toLowerCase();
      if (LINT_SCRIPTS.some((s) => lower === s || lower.startsWith(s + ':'))) {
        lint.push(`${prefix}npm run ${name}`);
      } else if (TYPE_SCRIPTS.some((s) => lower === s || lower.startsWith(s + ':'))) {
        build.push(`${prefix}npm run ${name}`);
      } else if (BUILD_SCRIPTS.some((s) => lower === s)) {
        build.push(`${prefix}npm run ${name}`);
      } else if (TEST_SCRIPTS.some((s) => lower === s)) {
        test.push(`${prefix}npm run ${name}`);
      }
    }
  } catch { /* ignore */ }

  return { lint, build, test };
}

export async function getProjectCommands(
  workspaceUri: vscode.Uri,
  subdir?: string
): Promise<ProjectCommands> {
  const root = workspaceUri.fsPath;
  const lint: string[] = [];
  const build: string[] = [];
  const test: string[] = [];
  const fs = await import('fs/promises');

  const pkgDirs = await findPackageJsonDirs(root, subdir);

  for (const pkgDir of pkgDirs) {
    const relDir = path.relative(root, pkgDir).replace(/\\/g, '/');
    const cmds = await parsePackageJsonCommands(pkgDir, relDir === '.' ? '' : relDir);
    lint.push(...cmds.lint);
    build.push(...cmds.build);
    test.push(...cmds.test);
  }

  // tsconfig.json в корне или subdir
  const tsconfigDirs = subdir
    ? [path.join(root, subdir), root]
    : [root];
  for (const dir of tsconfigDirs) {
    try {
      await fs.access(path.join(dir, 'tsconfig.json'));
      const relDir = path.relative(root, dir).replace(/\\/g, '/');
      const prefix = relDir && relDir !== '.' ? `cd ${relDir} && ` : '';
      const cmd = `${prefix}npx tsc --noEmit`;
      if (!build.some((c) => c.includes('tsc --noEmit')) && !build.some((c) => c.includes('typescript'))) {
        build.push(cmd);
      }
      break;
    } catch { /* no tsconfig */ }
  }

  // go.mod
  try {
    await fs.access(path.join(root, 'go.mod'));
    if (!build.includes('go build ./...')) build.push('go build ./...');
    if (!test.includes('go test ./...')) test.push('go test ./...');
  } catch { /* no go.mod */ }

  // python
  try {
    await fs.access(path.join(root, 'pyproject.toml'));
    if (!test.includes('pytest')) test.push('pytest');
  } catch {
    try {
      await fs.access(path.join(root, 'setup.py'));
      if (!test.includes('pytest')) test.push('pytest');
    } catch { /* no python */ }
  }

  // Дедупликация
  const unique = (arr: string[]) => [...new Set(arr)];
  const lintU = unique(lint);
  const buildU = unique(build);
  const testU = unique(test);
  const all = [...lintU, ...buildU];
  return { lint: lintU, build: buildU, test: testU, all };
}
