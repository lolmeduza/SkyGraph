import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ScannedFile } from './types';

const EXTENSIONS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.vue', '**/*.go', '**/*.py'];
const EXCLUDE =
  '{**/node_modules/**,**/vendor/**,**/dist/**,**/build/**,**/.git/**,**/.next/**,**/.nuxt/**,**/.output/**,**/__generated__/**,**/out/**,**/.code-index/**,**/.finder-index/**,**/.vscode/**,**/.idea/**,**/coverage/**,**/*.d.ts,**/*.min.js,**/*.min.css,**/pb/**}';

function isPbOrGenerated(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/');
  return p.includes('/pb/') || p.includes('.pb.');
}

export async function scanWorkspace(workspaceUri: vscode.Uri): Promise<ScannedFile[]> {
  const seen = new Set<string>();
  const result: ScannedFile[] = [];
  const workspacePath = workspaceUri.fsPath;

  for (const pattern of EXTENSIONS) {
    const uris = await vscode.workspace.findFiles(pattern, EXCLUDE, 50000);
    for (const uri of uris) {
      if (uri.scheme !== 'file') continue;
      const fullPath = uri.fsPath;
      if (!fullPath.startsWith(workspacePath)) continue;
      let relativePath = fullPath.slice(workspacePath.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
      if (seen.has(relativePath)) continue;
      if (isPbOrGenerated(relativePath)) continue;
      seen.add(relativePath);

      try {
        const data = await vscode.workspace.fs.readFile(uri);
        const content = new TextDecoder().decode(data);
        const contentHash = crypto.createHash('md5').update(content).digest('hex');
        const stat = await vscode.workspace.fs.stat(uri);
        const lastModified = stat.mtime ?? 0;

        result.push({
          path: fullPath,
          relativePath,
          content,
          contentHash,
          lastModified,
        });
      } catch {
        continue;
      }
    }
  }

  return result;
}

export function getProjectHash(files: ScannedFile[]): string {
  const hash = crypto.createHash('md5');
  for (const f of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(`${f.relativePath}:${f.contentHash}:${f.lastModified}`);
  }
  return hash.digest('hex');
}

const INDEXED_EXT = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.go', '.py'];
const EXCLUDED_PATH_PARTS = ['/node_modules/', '/vendor/', '/.nuxt/', '/.output/', '/__generated__/', '/out/', '/.code-index/', '/.finder-index/', '/.vscode/', '/.idea/', '/coverage/', '.d.ts', '.min.js', '.min.css', '/pb/', '.pb.'];

export function isIndexedFile(uri: vscode.Uri): boolean {
  const path = uri.fsPath.replace(/\\/g, '/');
  const ext = path.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
  if (!ext || !INDEXED_EXT.includes(ext)) return false;
  for (const part of EXCLUDED_PATH_PARTS) {
    if (path.includes(part) || path.endsWith(part)) return false;
  }
  return true;
}
