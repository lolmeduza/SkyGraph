import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, ChatState, HistoryIndex, PanelState } from './types';

export type { ChatMessage, ChatState, HistoryIndex, PanelState } from './types';

const DIR_NAME = '.skyGraph';
const CHATS_DIR = 'chats';
const INDEX_FILE = 'index.json';
const PANEL_STATE_FILE = 'panel-state.json';
export const USER_INSTRUCTIONS_FILE = 'user-instructions.md';
export const LLM_MISTAKES_FILE = 'llm-mistakes.md';

const MAX_MISTAKES = 30; // не даём файлу расти бесконечно

function workspaceDir(workspacePath: string): string {
  return path.join(workspacePath, DIR_NAME);
}

function chatsDir(workspacePath: string): string {
  return path.join(workspacePath, DIR_NAME, CHATS_DIR);
}

function panelStatePath(workspacePath: string): string {
  return path.join(workspaceDir(workspacePath), PANEL_STATE_FILE);
}

export function getUserInstructionsPath(workspacePath: string): string {
  return path.join(workspaceDir(workspacePath), USER_INSTRUCTIONS_FILE);
}

export function ensureUserInstructionsPath(workspacePath: string): string {
  ensureDir(workspaceDir(workspacePath));
  return getUserInstructionsPath(workspacePath);
}

export function ensureUserInstructionsFile(workspacePath: string): void {
  const filePath = ensureUserInstructionsPath(workspacePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf-8');
  }
}

export function getLLMMistakesPath(workspacePath: string): string {
  return path.join(workspaceDir(workspacePath), LLM_MISTAKES_FILE);
}

export function readLLMMistakes(workspacePath: string): string | null {
  const filePath = getLLMMistakesPath(workspacePath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function normalizeMistakeToRule(mistake: string): string {
  const lower = mistake.toLowerCase();

  // TS ошибки — извлекаем код и даём понятное правило
  const tsMatch = mistake.match(/\b(TS\d{4})\b[:\s]+(.{0,120})/i);
  if (tsMatch) {
    const code = tsMatch[1].toUpperCase();
    const detail = tsMatch[2].trim().replace(/['"][^'"]{30,}['"]/g, '"<value>"').replace(/\b\w+\.(ts|tsx|js)\b/g, '<file>');
    return `${code}: ${detail}`;
  }

  // ESLint ошибки
  if (lower.includes('eslint') || mistake.match(/@\w+\/\w+|no-\w+|prefer-\w+/)) {
    const ruleMatch = mistake.match(/([@\w/-]+rule|no-[\w-]+|prefer-[\w-]+|[\w-]+\/[\w-]+)/i);
    const rule = ruleMatch ? ruleMatch[1] : 'eslint';
    return `eslint/${rule}: нарушение правила линтера — проверь код перед propose_edits`;
  }

  // Go ошибки
  if (lower.includes('undefined') && lower.includes('go')) {
    return `go: undefined symbol — проверь импорты и имена перед propose_edits`;
  }

  // Убираем префикс "Ошибка валидации (попытка N):" — он шумный
  return mistake.replace(/^Ошибка валидации \(попытка \d+\):\s*/i, '').trim();
}

export function appendLLMMistake(workspacePath: string, mistake: string): void {
  const dir = workspaceDir(workspacePath);
  ensureDir(dir);
  const filePath = getLLMMistakesPath(workspacePath);

  let existing: string[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      // Читаем только строки вида "- ...", пропуская заголовки и пустые строки
      existing = raw
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).trim())
        .filter(Boolean);
    } catch {
      existing = [];
    }
  }

  const rule = normalizeMistakeToRule(mistake);

  // Дедупликация: по коду ошибки (TS2345, eslint/rule) или по первым 60 символам
  const ruleKey = rule.slice(0, 60).toLowerCase();
  const alreadyKnown = existing.some((m) => m.slice(0, 60).toLowerCase() === ruleKey);
  if (alreadyKnown) return;

  existing.push(rule);
  if (existing.length > MAX_MISTAKES) {
    existing = existing.slice(existing.length - MAX_MISTAKES);
  }

  const content = '# Ошибки LLM (автоматически)\n\n' + existing.map((m) => `- ${m}`).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function readUserInstructions(workspacePath: string): string | null {
  const filePath = getUserInstructionsPath(workspacePath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function getPanelState(workspacePath: string): PanelState | null {
  const filePath = panelStatePath(workspacePath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.openIds) && typeof data?.activeId === 'string') {
      return { openIds: data.openIds, activeId: data.activeId };
    }
  } catch {
    // ignore
  }
  return null;
}

export function savePanelState(
  workspacePath: string,
  openIds: string[],
  activeId: string
): void {
  const dir = workspaceDir(workspacePath);
  ensureDir(dir);
  const filePath = panelStatePath(workspacePath);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ openIds, activeId }, null, 0),
    'utf-8'
  );
}

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getHistory(workspacePath: string): ChatState[] {
  const dir = chatsDir(workspacePath);
  const indexPath = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  const indexRaw = fs.readFileSync(indexPath, 'utf-8');
  let index: HistoryIndex;
  try {
    const parsed = JSON.parse(indexRaw);
    index = Array.isArray(parsed?.chats) ? parsed : { chats: [] };
  } catch {
    return [];
  }
  const result: ChatState[] = [];
  for (const { id, name } of index.chats) {
    const filePath = path.join(dir, safeFileName(id));
    if (!fs.existsSync(filePath)) {
      result.push({ id, name, messages: [] });
      continue;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    let data: { messages: ChatMessage[] };
    try {
      data = JSON.parse(raw);
    } catch {
      result.push({ id, name, messages: [] });
      continue;
    }
    result.push({ id, name, messages: data.messages ?? [] });
  }
  return result;
}

export function saveChat(
  workspacePath: string,
  chatId: string,
  name: string,
  messages: ChatMessage[]
): void {
  const dir = chatsDir(workspacePath);
  ensureDir(dir);
  const indexPath = path.join(dir, INDEX_FILE);
  let index: HistoryIndex = { chats: [] };
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(parsed?.chats)) index = parsed;
    } catch {
      index = { chats: [] };
    }
  }
  const existing = index.chats.findIndex((c) => c.id === chatId);
  if (existing < 0) {
    index.chats.push({ id: chatId, name });
  } else {
    index.chats[existing].name = name;
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 0), 'utf-8');
  const filePath = path.join(dir, safeFileName(chatId));
  fs.writeFileSync(
    filePath,
    JSON.stringify({ messages }, null, 0),
    'utf-8'
  );
}

export function removeChat(workspacePath: string, chatId: string): void {
  const dir = chatsDir(workspacePath);
  const indexPath = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(indexPath)) return;
  let index: HistoryIndex;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (!Array.isArray(parsed?.chats)) return;
    index = parsed;
  } catch {
    return;
  }
  index.chats = index.chats.filter((c) => c.id !== chatId);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 0), 'utf-8');
  const filePath = path.join(dir, safeFileName(chatId));
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
