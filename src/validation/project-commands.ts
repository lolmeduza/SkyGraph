import * as vscode from 'vscode';
import * as path from 'path';

export interface ProjectCommands {
  lint: string[];
  build: string[];
  test: string[];
  all: string[];
}

export async function getProjectCommands(workspaceUri: vscode.Uri): Promise<ProjectCommands> {
  const root = workspaceUri.fsPath;
  const lint: string[] = [];
  const build: string[] = [];
  const test: string[] = [];
  const fs = await import('fs/promises');

  try {
    const pkgPath = path.join(root, 'package.json');
    await fs.access(pkgPath);
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg?.scripts ?? {};
    if (typeof scripts.lint === 'string') lint.push('npm run lint');
    if (typeof scripts.check === 'string') lint.push('npm run check');
    if (typeof scripts.typecheck === 'string') build.push('npm run typecheck');
    if (typeof scripts.build === 'string') build.push('npm run build');
    if (typeof scripts.test === 'string') test.push('npm test');
  } catch {
    // no package.json or invalid
  }

  try {
    const tsconfigPath = path.join(root, 'tsconfig.json');
    await fs.access(tsconfigPath);
    if (build.indexOf('npx tsc --noEmit') < 0) build.push('npx tsc --noEmit');
  } catch {
    // no tsconfig
  }

  try {
    await fs.access(path.join(root, 'go.mod'));
    if (build.indexOf('go build ./...') < 0) build.push('go build ./...');
    if (test.indexOf('go test ./...') < 0) test.push('go test ./...');
  } catch {
    // no go.mod
  }

  try {
    await fs.access(path.join(root, 'pyproject.toml'));
    if (test.indexOf('pytest') < 0) test.push('pytest');
  } catch {
    try {
      await fs.access(path.join(root, 'setup.py'));
      if (test.indexOf('pytest') < 0) test.push('pytest');
    } catch {
      // no python project
    }
  }

  const all = [...lint, ...build];
  return { lint, build, test, all };
}
