function getExtension(path: string): string {
  const match = path.match(/\.(tsx?|jsx?|vue|go|py)$/i);
  return match ? match[0] : '';
}

function basename(path: string, ext: string): string {
  let name = path.replace(/^.*[/\\]/, '');
  if (ext && name.toLowerCase().endsWith(ext.toLowerCase())) {
    name = name.slice(0, -ext.length);
  }
  return name;
}

export function detectPattern(path: string): string {
  const lower = ('/' + path.toLowerCase()).replace(/\\/g, '/');
  const filename = basename(path, getExtension(path)).toLowerCase();

  if (lower.includes('/pages/')) return 'page';
  if (lower.includes('/components/')) return 'component';
  if (lower.includes('/services/')) return 'service';
  if (lower.includes('/api/')) return 'api';
  if (lower.includes('/hooks/')) return 'hook';
  if (lower.includes('/store/')) return 'store';
  if (lower.includes('/utils/')) return 'utils';
  if (lower.includes('/handlers/')) return 'handler';
  if (lower.includes('/models/')) return 'model';
  if (lower.includes('/repository/') || lower.includes('/repositories/')) return 'repository';
  if (lower.includes('/cmd/')) return 'cmd';
  if (lower.includes('/internal/') && (filename.startsWith('get_') || filename.startsWith('post_') || filename.startsWith('put_') || filename.startsWith('delete_')) && !filename.includes('_test')) return 'handler';
  if (lower.includes('/internal/')) return 'internal';
  if (lower.includes('/pkg/')) return 'pkg';
  if (lower.includes('/migrations/')) return 'migrations';

  if (filename.includes('settings')) return 'settings';
  if (filename.includes('config')) return 'config';
  if (filename.includes('query')) return 'query';
  if (filename.includes('table')) return 'table';
  if (filename.includes('form')) return 'form';

  return 'other';
}

export function detectDomain(path: string): string {
  const structureMatch = path.match(/(?:src|pages|components|cmd|internal|pkg|handlers|models|api|services|store|utils|hooks)[/\\](\w+)[/\\]/i);
  if (structureMatch) return structureMatch[1];
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes('table')) return 'table';
  if (lowerPath.includes('form')) return 'form';
  if (lowerPath.includes('api') || lowerPath.includes('service')) return 'api';
  if (lowerPath.includes('component')) return 'component';
  if (lowerPath.includes('hook')) return 'hook';
  if (lowerPath.includes('util')) return 'util';
  return 'global';
}
