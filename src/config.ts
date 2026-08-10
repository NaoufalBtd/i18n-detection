import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScannerConfig } from './types.js';

export const DEFAULT_CONFIG: ScannerConfig = {
  include: ['src/**/*.{ts,tsx}'],
  exclude: [
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.spec.ts',
    '**/*.spec.tsx',
    '**/*.stories.tsx',
    '**/__tests__/**',
    '**/mocks/**',
    '**/fixtures/**',
    '**/generated/**',
    '**/.next/**',
    '**/node_modules/**'
  ],
  i18n: {
    library: 'next-intl',
    translationFunctionName: 't',
    clientHook: 'useTranslations',
    serverAsyncFunction: 'getTranslations',
    messagesPath: 'messages/en.json',
    catalogFormat: 'nested-json',
    keyStyle: 'namespace.dot.camelCase'
  },
  checkedAttributes: [
    'title',
    'label',
    'placeholder',
    'alt',
    'aria-label',
    'aria-placeholder',
    'description',
    'message',
    'helperText',
    'emptyText',
    'confirmLabel',
    'cancelLabel',
    'submitLabel',
    'tooltip',
    'content',
    'caption'
  ],
  ignoredAttributes: [
    'id',
    'key',
    'class',
    'className',
    'style',
    'type',
    'name',
    'role',
    'href',
    'src',
    'target',
    'rel',
    'variant',
    'size',
    'color',
    'data-testid',
    'data-test'
  ],
  checkedComponentProps: {
    'PageHeader': ['title', 'subtitle', 'description'],
    'EmptyState': ['title', 'description', 'actionLabel'],
    'ConfirmDialog': ['title', 'description', 'confirmLabel', 'cancelLabel'],
    'Dialog': ['title', 'description'],
    'Button': ['label', 'aria-label'],
    'DataTable': ['emptyText', 'loadingText']
  },
  checkedFunctions: {
    'toast.success': [0],
    'toast.error': [0],
    'toast.info': [0],
    'toast.warning': [0],
    'notify': [0],
    'showToast': [0],
    'alert': [0],
    'confirm': [0]
  },
  checkedObjectKeys: [
    'title',
    'subtitle',
    'description',
    'label',
    'message',
    'helperText',
    'emptyText',
    'header',
    'footer',
    'caption',
    'tooltip',
    'placeholder'
  ],
  ignoredObjectKeys: [
    'id',
    'key',
    'type',
    'kind',
    'variant',
    'size',
    'status',
    'accessorKey',
    'field',
    'name',
    'path',
    'route',
    'href',
    'method',
    'event',
    'className'
  ],
  allowedStrings: ['OK', 'ID', 'API', 'URL'],
  commonMappings: {
    'Save': 'common.actions.save',
    'Cancel': 'common.actions.cancel',
    'Delete': 'common.actions.delete',
    'Edit': 'common.actions.edit',
    'Create': 'common.actions.create',
    'Search': 'common.actions.search',
    'Loading': 'common.status.loading',
    'No results': 'common.empty.noResults'
  },
  scanErrors: false,
  uiConfigVariables: ['columns', 'tabs', 'steps', 'menuItems', 'navItems'],
  uiConfigTypes: ['ColumnDef', 'TabItem', 'StepConfig', 'MenuItem'],
  features: {
    sameFileConstants: true,
    sameFileObjects: true,
    conditionalStrings: true,
    templateLiterals: true,
    stringConcatenation: true,
    crossFileConstants: false,
    codemod: false,
    insertClientTranslations: false,
    insertServerTranslations: false
  },
  codemod: {
    importStatement: "import { useTranslation } from 'react-i18next';",
    hookStatement: "const { t } = useTranslation();"
  }
};

export function loadConfig(configPath?: string): ScannerConfig {
  const resolvedPath = configPath || path.join(process.cwd(), 'i18n-scan.config.json');
  if (fs.existsSync(resolvedPath)) {
    try {
      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const loaded = JSON.parse(fileContent);
      return {
        ...DEFAULT_CONFIG,
        ...loaded,
        i18n: { ...DEFAULT_CONFIG.i18n, ...loaded.i18n },
        features: { ...DEFAULT_CONFIG.features, ...loaded.features },
        codemod: { ...DEFAULT_CONFIG.codemod, ...loaded.codemod }
      };
    } catch (e: any) {
      console.warn(`Warning: Failed to parse config file at ${resolvedPath}. Using defaults. Error: ${e.message}`);
    }
  }
  return DEFAULT_CONFIG;
}
