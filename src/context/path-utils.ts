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

const CONTENT_HINTS: [RegExp, string][] = [
  [/(?:@Controller|@RestController|@RequestMapping|app\.(?:get|post|put|delete|patch|use)\s*\()/i, 'handler'],
  [/(?:@Entity|@Table|@Column|@PrimaryGeneratedColumn|schema\.\w+|class\s+\w+\s+extends\s+(?:Model|Entity|BaseEntity))/i, 'model'],
  [/(?:@Injectable|@Service|class\s+\w+Service)/i, 'service'],
  [/(?:@Resolver|@Query|@Mutation|@Subscription)/i, 'resolver'],
  [/(?:createStore|defineStore|configureStore|createSlice|combineReducers|new\s+Vuex\.Store)/i, 'store'],
  [/(?:createRouter|definePageMeta|getStaticProps|getServerSideProps|export\s+default\s+function\s+\w*Page)/i, 'page'],
  [/(?:axios\.\w+\s*\(|fetch\s*\(|http\.\w+\s*\(|\.get\s*<|\.post\s*<|\.put\s*<|\.delete\s*<)/i, 'service'],
  [/(?:use[A-Z]\w*\s*=\s*(?:async\s+)?\(|function\s+use[A-Z]\w*\s*\()/i, 'hook'],
  [/(?:defineComponent|export\s+default\s+\{[^}]*(?:setup|render|template|components)\s*[:(])/i, 'component'],
  [/(?:React\.(?:memo|forwardRef)\s*\(|(?:function|const)\s+\w+\s*[=(]\s*(?:\([^)]*\)\s*(?::\s*\w+)?\s*)?=>?\s*(?:\{[^}]*return\s+)?<)/i, 'component'],
];

const NAME_HINTS: [RegExp, string][] = [
  [/page|view/i, 'page'],
  [/component|widget|block|card|modal|dialog/i, 'component'],
  [/service|api|http|client/i, 'service'],
  [/store|slice|state|reducer/i, 'store'],
  [/config|settings|env/i, 'config'],
  [/hook|use[A-Z]/i, 'hook'],
  [/form|input|field|button/i, 'form'],
  [/table|list|grid/i, 'table'],
  [/utils?|helpers?|tools/i, 'utils'],
  [/handler|controller|route/i, 'handler'],
  [/model|entity|schema|dto/i, 'model'],
  [/resolver|query|mutation/i, 'resolver'],
  [/repository|repo|dao/i, 'repository'],
  [/middleware|guard|interceptor/i, 'middleware'],
  [/test|spec/i, 'test'],
  [/migration/i, 'migrations'],
];

export function detectPattern(path: string, content: string): string {
  const lower = ('/' + path.toLowerCase()).replace(/\\/g, '/');
  const filename = basename(path, getExtension(path)).toLowerCase();

  // Content-based detection has higher priority
  if (content) {
    for (const [re, type] of CONTENT_HINTS) {
      if (re.test(content)) return type;
    }
  }

  // Directory-based detection
  if (lower.includes('/pages/') || lower.includes('/views/')) return 'page';
  if (lower.includes('/components/')) return 'component';
  if (lower.includes('/services/')) return 'service';
  if (lower.includes('/api/')) return 'api';
  if (lower.includes('/hooks/') || lower.includes('/composables/')) return 'hook';
  if (lower.includes('/store/') || lower.includes('/stores/')) return 'store';
  if (lower.includes('/utils/') || lower.includes('/helpers/')) return 'utils';
  if (lower.includes('/handlers/') || lower.includes('/controllers/')) return 'handler';
  if (lower.includes('/models/') || lower.includes('/entities/')) return 'model';
  if (lower.includes('/repository/') || lower.includes('/repositories/')) return 'repository';
  if (lower.includes('/resolvers/')) return 'resolver';
  if (lower.includes('/middleware/') || lower.includes('/middlewares/')) return 'middleware';
  if (lower.includes('/cmd/')) return 'cmd';
  if (lower.includes('/internal/') && (filename.startsWith('get_') || filename.startsWith('post_') || filename.startsWith('put_') || filename.startsWith('delete_')) && !filename.includes('_test')) return 'handler';
  if (lower.includes('/internal/')) return 'internal';
  if (lower.includes('/pkg/')) return 'pkg';
  if (lower.includes('/migrations/')) return 'migrations';
  if (lower.includes('/__tests__/') || lower.includes('/test/') || lower.includes('/tests/')) return 'test';

  // Filename-based detection
  for (const [re, type] of NAME_HINTS) {
    if (re.test(filename)) return type;
  }

  return 'other';
}

export function detectDomain(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').map((s) => s.toLowerCase());

  const knownDirs = new Set([
    'src', 'pages', 'components', 'cmd', 'internal', 'pkg',
    'handlers', 'models', 'api', 'services', 'store', 'stores',
    'utils', 'hooks', 'composables', 'views', 'controllers',
    'resolvers', 'middleware', 'middlewares', 'entities',
    'repositories', 'repository', 'helpers', 'lib', 'app',
    'modules', 'features', 'test', 'tests', '__tests__',
  ]);

  for (let i = 0; i < segments.length - 1; i++) {
    if (knownDirs.has(segments[i]) && segments[i + 1] && !knownDirs.has(segments[i + 1])) {
      const candidate = segments[i + 1];
      if (candidate && !candidate.includes('.') && candidate.length > 1) {
        return candidate;
      }
    }
  }

  const lowerPath = path.toLowerCase();
  if (lowerPath.includes('table')) return 'table';
  if (lowerPath.includes('form')) return 'form';
  if (lowerPath.includes('api') || lowerPath.includes('service')) return 'api';
  if (lowerPath.includes('component')) return 'component';
  if (lowerPath.includes('hook')) return 'hook';
  if (lowerPath.includes('util')) return 'util';
  return 'global';
}
