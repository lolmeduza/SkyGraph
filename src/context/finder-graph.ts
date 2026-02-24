import * as vscode from 'vscode';
import { getIndex } from './indexer';

const GRAPH_FILE = 'pattern-graph.json';
const CODE_INDEX_DIR = '.code-index';
const MAX_CONTEXT_CHARS = 6000;
const MAX_RELEVANT_FILES = 18;

interface PatternGraph {
  meta?: { projectRoot: string; generatedAt: string; version: string };
  patterns?: Record<string, Record<string, number>>;
  filesByPattern?: Record<string, string[]>;
  examples?: Record<string, string>;
  files?: Record<string, { relatedFiles: string[]; relatedPatterns: string[] }>;
}

function getRelevantPathsForQuery(index: Awaited<ReturnType<typeof getIndex>>, query: string): string[] {
  if (!index) return [];
  const tokens = query.toLowerCase().split(/[\s/\\_\-.]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const scored: { path: string; score: number }[] = [];
  for (const rel of Object.keys(index.files)) {
    const lower = rel.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (lower.includes(t)) score++;
    }
    if (score > 0) scored.push({ path: rel, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RELEVANT_FILES).map((r) => r.path);
}

export async function getFinderProjectContext(
  workspaceUri: vscode.Uri,
  activeFileRelative?: string | null,
  userQuery?: string | null
): Promise<string | null> {
  const fileUri = vscode.Uri.joinPath(workspaceUri, CODE_INDEX_DIR, GRAPH_FILE);
  let raw: string;
  try {
    const data = await vscode.workspace.fs.readFile(fileUri);
    raw = new TextDecoder().decode(data);
  } catch {
    return null;
  }
  let graph: PatternGraph;
  try {
    graph = JSON.parse(raw);
  } catch {
    return null;
  }
  const parts: string[] = [];
  const index = await getIndex(workspaceUri);

  if (userQuery?.trim()) {
    const relevant = getRelevantPathsForQuery(index, userQuery.trim());
    if (relevant.length > 0) {
      parts.push('Релевантные файлы по запросу: ' + relevant.join(', '));
    }
  }

  if (graph.examples && Object.keys(graph.examples).length > 0) {
    parts.push('Паттерны проекта: ' + Object.entries(graph.examples).map(([p, desc]) => `${p} (${desc})`).join('; '));
  }

  if (graph.filesByPattern && Object.keys(graph.filesByPattern).length > 0) {
    const byPattern: string[] = [];
    const maxFilesPerPattern = 8;
    for (const [pattern, files] of Object.entries(graph.filesByPattern)) {
      const list = files.length > maxFilesPerPattern ? files.slice(0, maxFilesPerPattern).join(', ') + ` (+${files.length - maxFilesPerPattern})` : files.join(', ');
      byPattern.push(`${pattern}: ${list}`);
    }
    parts.push('Файлы по паттернам:\n' + byPattern.join('\n'));
  }

  if (activeFileRelative) {
    const entry = index?.files?.[activeFileRelative];
    const pattern = entry?.pattern;
    if (pattern && graph.patterns && graph.filesByPattern) {
      const relatedPatterns = Object.keys(graph.patterns[pattern] || {}).slice(0, 15);
      const relatedFiles: string[] = [];
      const seen = new Set<string>();
      for (const p of [pattern, ...relatedPatterns]) {
        for (const path of graph.filesByPattern[p] || []) {
          if (path !== activeFileRelative && !seen.has(path)) {
            seen.add(path);
            relatedFiles.push(path);
            if (relatedFiles.length >= 12) break;
          }
        }
        if (relatedFiles.length >= 12) break;
      }
      if (relatedPatterns.length || relatedFiles.length) {
        const rel: string[] = [];
        if (relatedPatterns.length) rel.push('связанные паттерны: ' + relatedPatterns.join(', '));
        if (relatedFiles.length) rel.push('связанные файлы: ' + relatedFiles.slice(0, 12).join(', '));
        parts.push('Текущий файл (' + activeFileRelative + '): ' + rel.join('; '));
      }
    }
  }

  if (parts.length === 0) return null;
  const text = parts.join('\n\n');
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) + '…' : text;
}

export function getActiveFileRelative(workspaceUri: vscode.Uri): string | null {
  const doc = vscode.window.activeTextEditor?.document?.uri;
  if (!doc || doc.scheme !== 'file') return null;
  const workspacePath = workspaceUri.fsPath;
  const docPath = doc.fsPath;
  if (!docPath.startsWith(workspacePath)) return null;
  const relative = docPath.slice(workspacePath.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
  return relative || null;
}
