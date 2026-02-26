import * as vscode from 'vscode';
import { FileIndexEntry } from './types';

const MAX_FILES_PER_PATTERN = 30;

interface GraphNode {
  file: string;
  pattern: string;
  domain: string;
  imports: string[];
  exports: string[];
}

interface PatternRelation {
  from: string;
  to: string;
  weight: number;
}

export interface PatternGraphData {
  meta: { projectRoot: string; generatedAt: string; version: string };
  patterns: Record<string, Record<string, number>>;
  filesByPattern: Record<string, string[]>;
  examples: Record<string, string>;
  files: Record<string, { relatedFiles: string[]; relatedPatterns: string[] }>;
}

function basename(path: string, ext?: string): string {
  let name = path.replace(/^.*[/\\]/, '');
  if (ext && name.toLowerCase().endsWith(ext.toLowerCase())) name = name.slice(0, -ext.length);
  return name;
}

function getExt(path: string): string {
  const m = path.match(/\.(tsx?|jsx?|vue|go|py)$/i);
  return m ? m[0] : '';
}

function isGeneratedOrPb(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/');
  return p.includes('/pb/') || p.includes('.pb.');
}

function resolveImportToFile(
  importPath: string,
  importerFile: string,
  fileSet: Set<string>
): string | null {
  if (importPath.startsWith('.')) {
    const importerDir = importerFile.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
    const parts = importerDir.split('/');
    for (const seg of importPath.replace(/\\/g, '/').split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    const resolved = parts.join('/');

    const candidates = [
      resolved,
      resolved + '.ts', resolved + '.tsx', resolved + '.js', resolved + '.jsx', resolved + '.vue',
      resolved + '/index.ts', resolved + '/index.tsx', resolved + '/index.js', resolved + '/index.jsx',
    ];
    for (const c of candidates) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  const importBase = importPath.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
  if (!importBase) return null;
  const lower = importBase.toLowerCase();
  for (const f of fileSet) {
    const fBase = basename(f, getExt(f)).toLowerCase();
    if (fBase === lower) return f;
  }
  return null;
}

function buildNodes(index: Record<string, FileIndexEntry>): GraphNode[] {
  return Object.values(index)
    .filter((entry) => !isGeneratedOrPb(entry.relativePath))
    .map((entry) => ({
      file: entry.relativePath,
      pattern: entry.pattern,
      domain: entry.domain,
      imports: entry.imports ?? [],
      exports: entry.exports ?? [],
    }));
}

function detectRelations(
  nodes: GraphNode[],
  fileSet: Set<string>,
  nodeByFile: Map<string, GraphNode>
): { patternRelations: PatternRelation[]; fileRelations: Map<string, Set<string>> } {
  const relationMap = new Map<string, number>();
  const fileRelations = new Map<string, Set<string>>();

  for (const node of nodes) {
    const related = new Set<string>();

    for (const imp of node.imports) {
      const target = resolveImportToFile(imp, node.file, fileSet);
      if (target && target !== node.file) {
        related.add(target);
        const targetNode = nodeByFile.get(target);
        if (targetNode && targetNode.pattern !== node.pattern) {
          const key = `${node.pattern}->${targetNode.pattern}`;
          relationMap.set(key, (relationMap.get(key) || 0) + 1);
        }
      }
    }

    const sameDomain = nodes.filter(
      (n) => n.domain === node.domain && n.domain !== 'global' && n.file !== node.file && n.pattern !== node.pattern
    );
    for (const d of sameDomain.slice(0, 10)) {
      const key = `${node.pattern}->${d.pattern}`;
      relationMap.set(key, (relationMap.get(key) || 0) + 0.3);
    }

    if (related.size > 0) {
      fileRelations.set(node.file, related);
    }
  }

  const patternRelations: PatternRelation[] = [];
  for (const [key, weight] of relationMap.entries()) {
    const [from, to] = key.split('->');
    if (from && to) patternRelations.push({ from, to, weight });
  }
  return { patternRelations, fileRelations };
}

const PATTERN_EXAMPLES: Record<string, string> = {
  page: 'Компонент страницы, подключающий сервисы, отображающий данные и использующий компоненты.',
  component: 'UI-компонент с пропсами, событиями и логикой отображения.',
  service: 'API-обертка с методами для работы с бэкендом (get, post, put, delete).',
  api: 'API-клиент или конфигурация для работы с внешними сервисами.',
  hook: 'Кастомный хук для переиспользования логики (useState, useEffect и т.д.).',
  store: 'Управление состоянием приложения (Vuex, Pinia, Redux и т.д.).',
  utils: 'Утилитарные функции для работы с данными, форматированием и т.д.',
  form: 'Компонент формы с валидацией и обработкой данных.',
  table: 'Компонент таблицы для отображения списков данных.',
  config: 'Конфигурационные файлы и настройки.',
  settings: 'Настройки и параметры компонентов или страниц.',
  query: 'Работа с query-параметрами и фильтрацией.',
  handler: 'Обработчик HTTP/запросов (Go handler, Python view и т.д.).',
  model: 'Модель данных, сущность БД, DTO.',
  repository: 'Слой доступа к данным (репозиторий).',
  resolver: 'GraphQL-резолвер (Query, Mutation, Subscription).',
  middleware: 'Middleware, Guard или Interceptor.',
  cmd: 'Точка входа приложения (Go cmd, main).',
  internal: 'Внутренние пакеты/модули (Go internal).',
  pkg: 'Переиспользуемые пакеты (Go pkg).',
  migrations: 'Миграции БД.',
  test: 'Тестовый файл.',
  other: 'Прочие файлы проекта.',
};

export function buildGraphFromIndex(
  index: Record<string, FileIndexEntry>,
  workspacePath: string
): PatternGraphData {
  const nodes = buildNodes(index);
  const fileSet = new Set(nodes.map((n) => n.file));
  const nodeByFile = new Map(nodes.map((n) => [n.file, n]));
  const { patternRelations, fileRelations } = detectRelations(nodes, fileSet, nodeByFile);

  const examples: Record<string, string> = {};
  const patternSet = new Set(nodes.map((n) => n.pattern));
  for (const p of patternSet) {
    examples[p] = PATTERN_EXAMPLES[p] ?? PATTERN_EXAMPLES.other;
  }

  const graph: PatternGraphData = {
    meta: {
      projectRoot: workspacePath,
      generatedAt: new Date().toISOString(),
      version: '2.0',
    },
    patterns: {},
    filesByPattern: {},
    examples,
    files: {},
  };

  for (const node of nodes) {
    if (!graph.filesByPattern[node.pattern]) graph.filesByPattern[node.pattern] = [];
    if (graph.filesByPattern[node.pattern].length < MAX_FILES_PER_PATTERN) {
      graph.filesByPattern[node.pattern].push(node.file);
    }
  }

  for (const rel of patternRelations) {
    if (!graph.patterns[rel.from]) graph.patterns[rel.from] = {};
    graph.patterns[rel.from][rel.to] = (graph.patterns[rel.from][rel.to] || 0) + rel.weight;
  }

  // Symmetrical edges
  const symmetric: Record<string, Record<string, number>> = {};
  for (const pattern in graph.patterns) {
    if (!symmetric[pattern]) symmetric[pattern] = {};
    for (const to in graph.patterns[pattern]) {
      symmetric[pattern][to] = graph.patterns[pattern][to];
      if (!symmetric[to]) symmetric[to] = {};
      symmetric[to][pattern] = (symmetric[to][pattern] || 0) + graph.patterns[pattern][to] * 0.8;
    }
  }
  graph.patterns = symmetric;

  // Normalize weights to [0, 1]
  const minWeight = 0.05;
  const emptyPatterns: string[] = [];
  for (const pattern in graph.patterns) {
    let max = 0;
    for (const to in graph.patterns[pattern]) max = Math.max(max, graph.patterns[pattern][to]);
    if (max === 0) { emptyPatterns.push(pattern); continue; }
    for (const to in graph.patterns[pattern]) {
      const w = Math.round((graph.patterns[pattern][to] / max) * 100) / 100;
      if (w < minWeight) delete graph.patterns[pattern][to];
      else graph.patterns[pattern][to] = Math.min(1, w);
    }
    if (Object.keys(graph.patterns[pattern]).length === 0) emptyPatterns.push(pattern);
  }
  for (const p of emptyPatterns) delete graph.patterns[p];

  // File-level relations
  for (const [file, related] of fileRelations) {
    const relatedPatterns = new Set<string>();
    for (const r of related) {
      const n = nodeByFile.get(r);
      if (n) relatedPatterns.add(n.pattern);
    }
    graph.files[file] = {
      relatedFiles: [...related].slice(0, 15),
      relatedPatterns: [...relatedPatterns],
    };
  }

  return graph;
}

const CODE_INDEX_DIR = '.code-index';
const GRAPH_FILE = 'pattern-graph.json';

export async function buildAndSaveGraph(
  workspaceUri: vscode.Uri,
  index: Record<string, FileIndexEntry>
): Promise<PatternGraphData> {
  const workspacePath = workspaceUri.fsPath;
  const graph = buildGraphFromIndex(index, workspacePath);
  const dirUri = vscode.Uri.joinPath(workspaceUri, CODE_INDEX_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  const fileUri = vscode.Uri.joinPath(workspaceUri, CODE_INDEX_DIR, GRAPH_FILE);
  const raw = JSON.stringify(graph, null, 2);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(raw));
  return graph;
}


export async function updateGraphForFiles(
  workspaceUri: vscode.Uri,
  fullIndex: Record<string, FileIndexEntry>,
  changedRelPaths: string[]
): Promise<PatternGraphData> {
  // Загружаем существующий граф если он есть
  const graphUri = vscode.Uri.joinPath(workspaceUri, CODE_INDEX_DIR, GRAPH_FILE);
  let existingGraph: PatternGraphData | null = null;
  try {
    const data = await vscode.workspace.fs.readFile(graphUri);
    existingGraph = JSON.parse(new TextDecoder().decode(data)) as PatternGraphData;
  } catch {
    // Нет существующего графа — строим полностью
    return buildAndSaveGraph(workspaceUri, fullIndex);
  }

  const changedSet = new Set(changedRelPaths);

  // Определяем «затронутые» файлы: изменённые + те кто на них ссылается
  const allNodes = buildNodes(fullIndex);
  const fileSet = new Set(allNodes.map((n) => n.file));
  const nodeByFile = new Map(allNodes.map((n) => [n.file, n]));

  const affected = new Set(changedRelPaths);
  for (const node of allNodes) {
    for (const imp of node.imports) {
      const target = resolveImportToFile(imp, node.file, fileSet);
      if (target && changedSet.has(target)) {
        affected.add(node.file);
      }
    }
  }

  // Строим новые file-level relations только для затронутых файлов
  const { fileRelations } = detectRelations(allNodes, fileSet, nodeByFile);

  // Обновляем граф: берём существующий и патчим затронутые файлы
  const updatedGraph: PatternGraphData = {
    ...existingGraph,
    meta: {
      ...existingGraph.meta,
      generatedAt: new Date().toISOString(),
    },
    files: { ...existingGraph.files },
  };

  // Удаляем записи для удалённых/изменённых файлов
  for (const rel of affected) {
    delete updatedGraph.files[rel];
  }

  // Добавляем/обновляем записи для файлов которые ещё существуют в индексе
  for (const rel of affected) {
    if (!fullIndex[rel]) continue;
    const related = fileRelations.get(rel);
    if (related) {
      const relatedPatterns = new Set<string>();
      for (const r of related) {
        const n = nodeByFile.get(r);
        if (n) relatedPatterns.add(n.pattern);
      }
      updatedGraph.files[rel] = {
        relatedFiles: [...related].slice(0, 15),
        relatedPatterns: [...relatedPatterns],
      };
    }
  }

  // filesByPattern: перестраиваем полностью (быстро — просто группировка)
  const newFilesByPattern: Record<string, string[]> = {};
  for (const node of allNodes) {
    if (!newFilesByPattern[node.pattern]) newFilesByPattern[node.pattern] = [];
    if (newFilesByPattern[node.pattern].length < MAX_FILES_PER_PATTERN) {
      newFilesByPattern[node.pattern].push(node.file);
    }
  }
  updatedGraph.filesByPattern = newFilesByPattern;

  // patterns (pattern relations): перестраиваем только если изменился паттерн затронутого файла
  const affectedPatterns = new Set(
    [...affected].map((rel) => fullIndex[rel]?.pattern).filter(Boolean) as string[]
  );
  // Если паттерн-состав изменился — перестраиваем pattern relations полностью (это быстро)
  if (affectedPatterns.size > 0) {
    const { patternRelations } = detectRelations(allNodes, fileSet, nodeByFile);
    const relationMap: Record<string, Record<string, number>> = {};
    for (const rel of patternRelations) {
      if (!relationMap[rel.from]) relationMap[rel.from] = {};
      relationMap[rel.from][rel.to] = (relationMap[rel.from][rel.to] || 0) + rel.weight;
    }
    // Симметрия
    const symmetric: Record<string, Record<string, number>> = {};
    for (const pattern in relationMap) {
      if (!symmetric[pattern]) symmetric[pattern] = {};
      for (const to in relationMap[pattern]) {
        symmetric[pattern][to] = relationMap[pattern][to];
        if (!symmetric[to]) symmetric[to] = {};
        symmetric[to][pattern] = (symmetric[to][pattern] || 0) + relationMap[pattern][to] * 0.8;
      }
    }
    // Нормализация
    const minWeight = 0.05;
    for (const pattern in symmetric) {
      let max = 0;
      for (const to in symmetric[pattern]) max = Math.max(max, symmetric[pattern][to]);
      if (max === 0) { delete symmetric[pattern]; continue; }
      for (const to in symmetric[pattern]) {
        const w = Math.round((symmetric[pattern][to] / max) * 100) / 100;
        if (w < minWeight) delete symmetric[pattern][to];
        else symmetric[pattern][to] = Math.min(1, w);
      }
      if (Object.keys(symmetric[pattern]).length === 0) delete symmetric[pattern];
    }
    updatedGraph.patterns = symmetric;
  }

  const dirUri = vscode.Uri.joinPath(workspaceUri, CODE_INDEX_DIR);
  await vscode.workspace.fs.createDirectory(dirUri);
  await vscode.workspace.fs.writeFile(graphUri, new TextEncoder().encode(JSON.stringify(updatedGraph, null, 2)));
  return updatedGraph;
}
