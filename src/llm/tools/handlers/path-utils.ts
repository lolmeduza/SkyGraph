import * as vscode from 'vscode';
import { getIndex } from '../../../context/indexer';

const DEPRIORITIZED_SEGMENTS = ['static-react', 'static', 'legacy', 'dist', 'build', 'generated', '__generated__'];

export function pathPenalty(p: string): number {
  const lower = p.toLowerCase();
  return DEPRIORITIZED_SEGMENTS.reduce(
    (acc, seg) => acc + (lower.includes('/' + seg + '/') || lower.startsWith(seg + '/') ? 1 : 0),
    0
  );
}

export async function resolvePathCandidates(
  requestedPath: string,
  workspaceUri: vscode.Uri
): Promise<string[]> {
  const segments = requestedPath.split('/').filter(Boolean);
  const filename = segments.pop() ?? requestedPath;
  const stem = filename.replace(/\.[^.]+$/, '');
  const dirPrefix = segments.join('/');

  const index = await getIndex(workspaceUri);
  if (!index) return [];

  const paths = Object.keys(index.files);
  const exactName = paths.filter((p) => p.endsWith('/' + filename) || p === filename);
  const byStem = paths.filter((p) => {
    if (exactName.includes(p)) return false;
    const lower = p.toLowerCase();
    return (
      (lower.includes('/' + stem.toLowerCase() + '/') ||
        lower.endsWith('/' + stem.toLowerCase())) &&
      /\.(tsx?|jsx?|vue|go|py)$/i.test(p)
    );
  });

  const candidates = [...exactName, ...byStem];
  if (candidates.length === 0) return [];

  candidates.sort((a, b) => {
    const aInDir = dirPrefix ? (a.startsWith(dirPrefix + '/') ? 0 : 1) : 0;
    const bInDir = dirPrefix ? (b.startsWith(dirPrefix + '/') ? 0 : 1) : 1;
    if (aInDir !== bInDir) return aInDir - bInDir;
    const penaltyDiff = pathPenalty(a) - pathPenalty(b);
    if (penaltyDiff !== 0) return penaltyDiff;
    return a.split('/').length - b.split('/').length;
  });

  return candidates.slice(0, 5);
}

/**
 * Читает файл по пути. При ENOENT пробует кандидатов из индекса.
 * Возвращает { content, resolvedPath } или null если не нашёл.
 */
export async function readFileWithFallback(
  filePath: string,
  workspaceUri: vscode.Uri
): Promise<{ content: string; resolvedPath: string } | null> {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const uri = vscode.Uri.joinPath(workspaceUri, normalized);
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    return { content: new TextDecoder().decode(data), resolvedPath: normalized };
  } catch {
    // Файл не найден по точному пути — ищем кандидатов
  }

  const candidates = await resolvePathCandidates(normalized, workspaceUri);
  for (const candidate of candidates) {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceUri, candidate));
      return { content: new TextDecoder().decode(data), resolvedPath: candidate };
    } catch {
      continue;
    }
  }
  return null;
}
