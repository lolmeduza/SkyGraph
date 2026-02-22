import { detectPattern, detectDomain } from '../path-utils';
import { ScannedFile, FileIndexEntry } from './types';

const IMPORT_REGEX =
  /(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
const VUE_SCRIPT_REGEX = /<script[^>]*>([\s\S]*?)<\/script>/i;

function extractImports(content: string, relativePath: string): string[] {
  const ext = relativePath.toLowerCase();
  const isVue = ext.endsWith('.vue');
  const isJsLike = ext.endsWith('.ts') || ext.endsWith('.tsx') || ext.endsWith('.js') || ext.endsWith('.jsx');
  if (!isJsLike && !isVue) return [];

  let toParse = content;
  if (isVue) {
    const m = content.match(VUE_SCRIPT_REGEX);
    if (m && m[1]) toParse = m[1];
  }

  const imports: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_REGEX.lastIndex = 0;
  while ((match = IMPORT_REGEX.exec(toParse)) !== null) {
    const spec = match[1].trim();
    if (spec && !spec.startsWith('.')) imports.push(spec);
  }
  return [...new Set(imports)];
}

export function extractEntry(file: ScannedFile): FileIndexEntry {
  const pattern = detectPattern(file.relativePath);
  const domain = detectDomain(file.relativePath);
  const imports = extractImports(file.content, file.relativePath);
  const lines = file.content.split('\n').length;

  return {
    file: file.path,
    relativePath: file.relativePath,
    pattern,
    domain,
    imports,
    contentHash: file.contentHash,
    metadata: {
      lines,
      lastModified: file.lastModified,
    },
  };
}
