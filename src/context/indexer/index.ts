import * as vscode from 'vscode';
import { scanWorkspace, getProjectHash } from './scanner';
import { extractEntry } from './extractor';
import { buildAndSaveGraph } from './pattern-graph';
import { IndexCache, FileIndexEntry } from './types';

const INDEX_DIR = '.code-index';
const INDEX_FILE = 'index.json';

function isUsefulEntry(entry: FileIndexEntry): boolean {
  if (entry.metadata.lines < 3) return false;
  if (entry.pattern === 'test') return false;

  const hasSymbols =
    entry.imports.length > 0 ||
    entry.exports.length > 0 ||
    entry.functions.length > 0 ||
    entry.classes.length > 0 ||
    entry.hooks.length > 0;

  if (entry.pattern === 'other' && !hasSymbols && entry.metadata.lines < 15) return false;
  return true;
}

export async function buildIndex(workspaceUri: vscode.Uri): Promise<IndexCache> {
  console.log('[SkyGraph] Индекс: сканирование...');
  const files = await scanWorkspace(workspaceUri);
  const projectHash = getProjectHash(files);

  const indexed: Record<string, FileIndexEntry> = {};
  for (const file of files) {
    const entry = extractEntry(file);
    if (isUsefulEntry(entry)) indexed[file.relativePath] = entry;
  }

  console.log('[SkyGraph] Индекс: построен', files.length, 'файлов →', Object.keys(indexed).length, 'записей');
  const cache: IndexCache = {
    version: '1.0',
    timestamp: Date.now(),
    files: indexed,
    metadata: {
      projectHash,
      lastScan: Date.now(),
      fileCount: files.length,
    },
  };

  const dirUri = vscode.Uri.joinPath(workspaceUri, INDEX_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(workspaceUri, INDEX_DIR, INDEX_FILE);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(cache, null, 2)));

  console.log('[SkyGraph] Граф: построение...');
  await buildAndSaveGraph(workspaceUri, indexed);
  console.log('[SkyGraph] Граф: построен, сохранён в .code-index/pattern-graph.json');

  return cache;
}

export async function getIndex(workspaceUri: vscode.Uri): Promise<IndexCache | null> {
  const fileUri = vscode.Uri.joinPath(workspaceUri, INDEX_DIR, INDEX_FILE);
  try {
    const data = await vscode.workspace.fs.readFile(fileUri);
    const cache: IndexCache = JSON.parse(new TextDecoder().decode(data));
    return cache.version && cache.files ? cache : null;
  } catch {
    return null;
  }
}

export async function getOrBuildIndex(workspaceUri: vscode.Uri): Promise<IndexCache | null> {
  const existing = await getIndex(workspaceUri);
  if (existing) {
    console.log('[SkyGraph] Индекс: загружен из кэша,', Object.keys(existing.files).length, 'записей');
    await ensureGraph(workspaceUri, existing.files);
    return existing;
  }
  return buildIndex(workspaceUri);
}

async function ensureGraph(workspaceUri: vscode.Uri, files: Record<string, FileIndexEntry>): Promise<void> {
  const graphUri = vscode.Uri.joinPath(workspaceUri, INDEX_DIR, 'pattern-graph.json');
  try {
    await vscode.workspace.fs.stat(graphUri);
  } catch {
    console.log('[SkyGraph] Граф: не найден, построение...');
    await buildAndSaveGraph(workspaceUri, files);
    console.log('[SkyGraph] Граф: построен');
  }
}

export async function updateIndex(workspaceUri: vscode.Uri): Promise<IndexCache | null> {
  const existing = await getIndex(workspaceUri);
  if (!existing) return null;

  const files = await scanWorkspace(workspaceUri);
  const projectHash = getProjectHash(files);
  if (existing.metadata.projectHash === projectHash) return existing;

  const filesToRemove = new Set(Object.keys(existing.files));
  const indexed: Record<string, FileIndexEntry> = { ...existing.files };

  for (const file of files) {
    filesToRemove.delete(file.relativePath);
    const prev = existing.files[file.relativePath];
    if (prev && prev.contentHash === file.contentHash) continue;
    const entry = extractEntry(file);
    if (isUsefulEntry(entry)) indexed[file.relativePath] = entry;
    else delete indexed[file.relativePath];
  }
  for (const rel of filesToRemove) delete indexed[rel];

  const cache: IndexCache = {
    version: existing.version,
    timestamp: Date.now(),
    files: indexed,
    metadata: {
      projectHash,
      lastScan: Date.now(),
      fileCount: files.length,
    },
  };
  const fileUri = vscode.Uri.joinPath(workspaceUri, INDEX_DIR, INDEX_FILE);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(cache, null, 2)));
  console.log('[SkyGraph] Индекс: обновлён,', Object.keys(indexed).length, 'записей');
  console.log('[SkyGraph] Граф: построение...');
  await buildAndSaveGraph(workspaceUri, indexed);
  console.log('[SkyGraph] Граф: обновлён');
  return cache;
}
