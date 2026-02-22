import * as vscode from 'vscode';
import { FileIndexEntry } from './types';

const MAX_FILES_PER_PATTERN = 30;

interface GraphNode {
  file: string;
  pattern: string;
  domain: string;
  imports: string[];
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

function buildNodes(index: Record<string, FileIndexEntry>): GraphNode[] {
  return Object.values(index)
    .filter((entry) => !isGeneratedOrPb(entry.relativePath))
    .map((entry) => ({
      file: entry.relativePath,
      pattern: entry.pattern,
      domain: entry.domain,
      imports: entry.imports ?? [],
    }));
}

function detectRelations(nodes: GraphNode[]): PatternRelation[] {
  const relationMap = new Map<string, number>();
  for (const node of nodes) {
    for (const imp of node.imports) {
      const related = nodes.find((n) => {
        const fileName = basename(n.file, getExt(n.file));
        const lower = n.file.toLowerCase();
        return imp.includes(fileName) || imp.includes(lower) || imp.includes(n.pattern);
      });
      if (related && related.file !== node.file && related.pattern !== node.pattern) {
        const key = `${node.pattern}->${related.pattern}`;
        relationMap.set(key, (relationMap.get(key) || 0) + 1);
      }
    }
    const sameDomain = nodes.filter(
      (n) => n.domain === node.domain && n.file !== node.file && n.pattern !== node.pattern
    );
    for (const d of sameDomain.slice(0, 10)) {
      const key = `${node.pattern}->${d.pattern}`;
      relationMap.set(key, (relationMap.get(key) || 0) + 0.5);
    }
  }
  const relations: PatternRelation[] = [];
  for (const [key, weight] of relationMap.entries()) {
    const [from, to] = key.split('->');
    if (from && to) relations.push({ from, to, weight });
  }
  return relations;
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
  cmd: 'Точка входа приложения (Go cmd, main).',
  internal: 'Внутренние пакеты/модули (Go internal).',
  pkg: 'Переиспользуемые пакеты (Go pkg).',
  migrations: 'Миграции БД.',
  other: 'Прочие файлы проекта.',
};

export function buildGraphFromIndex(
  index: Record<string, FileIndexEntry>,
  workspacePath: string
): PatternGraphData {
  const nodes = buildNodes(index);
  const relations = detectRelations(nodes);

  const examples: Record<string, string> = {};
  const patternSet = new Set(nodes.map((n) => n.pattern));
  for (const p of patternSet) {
    if (PATTERN_EXAMPLES[p]) examples[p] = PATTERN_EXAMPLES[p];
    else examples[p] = PATTERN_EXAMPLES.other;
  }

  const graph: PatternGraphData = {
    meta: {
      projectRoot: workspacePath,
      generatedAt: new Date().toISOString(),
      version: '1.0',
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

  for (const rel of relations) {
    if (!graph.patterns[rel.from]) graph.patterns[rel.from] = {};
    graph.patterns[rel.from][rel.to] = (graph.patterns[rel.from][rel.to] || 0) + rel.weight;
  }

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

  const maxWeights: Record<string, number> = {};
  for (const pattern in graph.patterns) {
    let max = 0;
    for (const to in graph.patterns[pattern]) max = Math.max(max, graph.patterns[pattern][to]);
    maxWeights[pattern] = max;
  }
  const minWeight = 0.05;
  const emptyPatterns: string[] = [];
  for (const pattern in graph.patterns) {
    const max = maxWeights[pattern] || 1;
    for (const to in graph.patterns[pattern]) {
      const w = Math.min(1, Math.max(0, Math.round((graph.patterns[pattern][to] / max) * 100) / 100));
      if (w < minWeight) delete graph.patterns[pattern][to];
      else graph.patterns[pattern][to] = w;
    }
    if (Object.keys(graph.patterns[pattern]).length === 0) emptyPatterns.push(pattern);
  }
  for (const p of emptyPatterns) delete graph.patterns[p];

  graph.files = {};

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
