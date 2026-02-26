import * as vscode from 'vscode';
import { getIndex } from './indexer';

const GRAPH_FILE = 'pattern-graph.json';
const CODE_INDEX_DIR = '.code-index';
const MAX_CONTEXT_CHARS = 8000;
const MAX_RELEVANT_FILES = 18;
// Максимум символов содержимого активного файла в контексте
const MAX_ACTIVE_FILE_CHARS = 2000;
// Максимум символов одного соседнего файла
const MAX_NEIGHBOR_CHARS = 600;
// Сколько соседей включать
const MAX_NEIGHBORS = 3;

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

async function readFileContent(workspaceUri: vscode.Uri, relativePath: string): Promise<string | null> {
  try {
    const uri = vscode.Uri.joinPath(workspaceUri, relativePath);
    const data = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(data);
  } catch {
    return null;
  }
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

  // 1. Содержимое активного файла + прямые соседи по графу импортов
  if (activeFileRelative) {
    const activeContent = await readFileContent(workspaceUri, activeFileRelative);
    if (activeContent) {
      const truncated = activeContent.length > MAX_ACTIVE_FILE_CHARS
        ? activeContent.slice(0, MAX_ACTIVE_FILE_CHARS) + '\n... (truncated)'
        : activeContent;
      parts.push(`=== Активный файл: ${activeFileRelative} ===\n${truncated}`);
    }

    // Прямые соседи из графа (файлы которые импортирует активный файл и которые его импортируют)
    const graphFileData = graph.files?.[activeFileRelative];
    const directNeighbors: string[] = graphFileData?.relatedFiles?.slice(0, MAX_NEIGHBORS) ?? [];

    // Если прямых соседей нет — берём соседей по паттерну из индекса
    if (directNeighbors.length === 0) {
      const entry = index?.files?.[activeFileRelative];
      const pattern = entry?.pattern;
      if (pattern && graph.filesByPattern) {
        const relatedPatterns = Object.keys(graph.patterns?.[pattern] || {}).slice(0, 5);
        const seen = new Set<string>([activeFileRelative]);
        for (const p of [pattern, ...relatedPatterns]) {
          for (const path of graph.filesByPattern[p] || []) {
            if (!seen.has(path)) {
              seen.add(path);
              directNeighbors.push(path);
              if (directNeighbors.length >= MAX_NEIGHBORS) break;
            }
          }
          if (directNeighbors.length >= MAX_NEIGHBORS) break;
        }
      }
    }

    if (directNeighbors.length > 0) {
      const neighborParts: string[] = [];
      for (const neighbor of directNeighbors) {
        const content = await readFileContent(workspaceUri, neighbor);
        if (!content) continue;
        const truncated = content.length > MAX_NEIGHBOR_CHARS
          ? content.slice(0, MAX_NEIGHBOR_CHARS) + '\n... (truncated)'
          : content;
        neighborParts.push(`=== ${neighbor} ===\n${truncated}`);
      }
      if (neighborParts.length > 0) {
        parts.push('Связанные файлы:\n' + neighborParts.join('\n\n'));
      }
    }
  }

  // 2. Релевантные файлы по запросу — с аннотациями из индекса
  if (userQuery?.trim() && index) {
    const relevant = getRelevantPathsForQuery(index, userQuery.trim());
    if (relevant.length > 0) {
      const annotated = relevant.map((path) => {
        const entry = index.files[path];
        if (!entry) return path;
        const parts: string[] = [path];
        if (entry.pattern) parts.push(`[${entry.pattern}]`);
        if (entry.exports?.length) parts.push(`exports: ${entry.exports.slice(0, 3).join(', ')}`);
        if (entry.functions?.length) parts.push(`fn: ${entry.functions.slice(0, 3).join(', ')}`);
        return parts.join('  ');
      });
      parts.push('Релевантные файлы:\n' + annotated.join('\n'));
    }
  }

  // 3. Паттерны проекта (без filesByPattern — слишком шумно, убираем)
  if (graph.examples && Object.keys(graph.examples).length > 0) {
    parts.push('Паттерны проекта: ' + Object.entries(graph.examples).map(([p, desc]) => `${p} (${desc})`).join('; '));
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
