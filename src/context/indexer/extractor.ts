import { detectPattern, detectDomain } from '../path-utils';
import { ScannedFile, FileIndexEntry } from './types';

const IMPORT_REGEX =
  /(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
const VUE_SCRIPT_REGEX = /<script[^>]*>([\s\S]*?)<\/script>/i;

const EXPORT_NAMED_RE = /export\s+(?:async\s+)?(?:function|const|let|var|class|enum|type|interface)\s+(\w+)/g;
const EXPORT_DEFAULT_RE = /export\s+default\s+(?:(?:async\s+)?(?:function|class)\s+)?(\w+)?/g;
const FUNCTION_RE = /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>)/g;
const CLASS_RE = /class\s+(\w+)/g;
const INTERFACE_RE = /interface\s+(\w+)/g;
const TYPE_RE = /type\s+(\w+)\s*(?:<[^>]*>)?\s*=/g;
const HOOK_RE = /(?:function|const|let|var)\s+(use[A-Z]\w+)/g;

function getScriptContent(content: string, relativePath: string): string | null {
  const ext = relativePath.toLowerCase();
  const isVue = ext.endsWith('.vue');
  const isJsLike = ext.endsWith('.ts') || ext.endsWith('.tsx') || ext.endsWith('.js') || ext.endsWith('.jsx');
  if (!isJsLike && !isVue) return null;

  if (isVue) {
    const m = content.match(VUE_SCRIPT_REGEX);
    return m?.[1] ?? null;
  }
  return content;
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_REGEX.lastIndex = 0;
  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    const spec = match[1].trim();
    if (spec) imports.push(spec);
  }
  return [...new Set(imports)];
}

function collectMatches(regex: RegExp, source: string): string[] {
  const results: string[] = [];
  let m: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((m = regex.exec(source)) !== null) {
    const name = m[1] || m[2];
    if (name) results.push(name);
  }
  return [...new Set(results)];
}

function extractExports(source: string): string[] {
  const named = collectMatches(EXPORT_NAMED_RE, source);
  const defaults = collectMatches(EXPORT_DEFAULT_RE, source).filter(Boolean);
  return [...new Set([...named, ...defaults])];
}

function extractTags(relativePath: string, hooks: string[], functions: string[]): string[] {
  const tags: string[] = [];
  const lower = relativePath.toLowerCase();
  if (lower.includes('table')) tags.push('table');
  if (lower.includes('form')) tags.push('form');
  if (lower.includes('settings')) tags.push('settings');
  if (lower.includes('config')) tags.push('config');
  if (lower.includes('query')) tags.push('query');
  if (lower.includes('modal') || lower.includes('dialog')) tags.push('modal');
  if (hooks.length > 0) tags.push('hooks');
  if (functions.length > 3) tags.push('functions');
  return [...new Set(tags)];
}

function calculateComplexity(
  functions: string[],
  classes: string[],
  hooks: string[],
  interfaces: string[],
  types: string[],
  exports: string[],
  lines: number
): number {
  return Math.round(
    functions.length * 2 +
      classes.length * 3 +
      hooks.length * 1.5 +
      interfaces.length +
      types.length +
      exports.length * 0.5 +
      Math.log2(Math.max(1, lines)) * 0.5
  );
}

export function extractEntry(file: ScannedFile): FileIndexEntry {
  const scriptContent = getScriptContent(file.content, file.relativePath);

  let imports: string[] = [];
  let exports: string[] = [];
  let functions: string[] = [];
  let classes: string[] = [];
  let interfaces: string[] = [];
  let types: string[] = [];
  let hooks: string[] = [];

  if (scriptContent) {
    imports = extractImports(scriptContent);
    exports = extractExports(scriptContent);
    functions = collectMatches(FUNCTION_RE, scriptContent);
    classes = collectMatches(CLASS_RE, scriptContent);
    interfaces = collectMatches(INTERFACE_RE, scriptContent);
    types = collectMatches(TYPE_RE, scriptContent);
    hooks = collectMatches(HOOK_RE, scriptContent);
  }

  const lines = file.content.split('\n').length;
  const pattern = detectPattern(file.relativePath, scriptContent ?? '');
  const domain = detectDomain(file.relativePath);
  const tags = extractTags(file.relativePath, hooks, functions);
  const complexity = calculateComplexity(functions, classes, hooks, interfaces, types, exports, lines);

  return {
    file: file.path,
    relativePath: file.relativePath,
    pattern,
    domain,
    imports,
    exports,
    functions,
    classes,
    interfaces,
    types,
    hooks,
    tags,
    contentHash: file.contentHash,
    metadata: {
      lines,
      complexity,
      lastModified: file.lastModified,
    },
  };
}
