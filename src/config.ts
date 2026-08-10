import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScannerConfig } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

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
    sourceLocale: 'en',
    translationFunctionName: 't',
    clientHook: 'useTranslations',
    serverAsyncFunction: 'getTranslations',
    messagesPath: 'messages/{locale}.json',
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
    PageHeader: ['title', 'subtitle', 'description'],
    EmptyState: ['title', 'description', 'actionLabel'],
    ConfirmDialog: ['title', 'description', 'confirmLabel', 'cancelLabel'],
    Dialog: ['title', 'description'],
    Button: ['label', 'aria-label'],
    DataTable: ['emptyText', 'loadingText']
  },
  checkedFunctions: {
    'toast.success': [0],
    'toast.error': [0],
    'toast.info': [0],
    'toast.warning': [0],
    notify: [0],
    showToast: [0],
    alert: [0],
    confirm: [0]
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
    Save: 'common.actions.save',
    Cancel: 'common.actions.cancel',
    Delete: 'common.actions.delete',
    Edit: 'common.actions.edit',
    Create: 'common.actions.create',
    Search: 'common.actions.search',
    Loading: 'common.status.loading',
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
    insertClientTranslations: true,
    insertServerTranslations: true
  },
  codemod: {
    framework: 'next-intl'
  }
};

function cloneDefault(): ScannerConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ScannerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, name: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    errors.push(`${name} must be an array of strings`);
  }
}


function validateRawConfig(raw: Record<string, unknown>): void {
  const allowedTopLevel = new Set([
    'include',
    'exclude',
    'i18n',
    'checkedAttributes',
    'ignoredAttributes',
    'checkedComponentProps',
    'checkedFunctions',
    'checkedObjectKeys',
    'ignoredObjectKeys',
    'allowedStrings',
    'commonMappings',
    'scanErrors',
    'uiConfigVariables',
    'uiConfigTypes',
    'features',
    'codemod'
  ]);
  const unknown = Object.keys(raw).filter(key => !allowedTopLevel.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`Unknown configuration field(s): ${unknown.join(', ')}`);
  }
  for (const nested of ['i18n', 'features', 'codemod'] as const) {
    if (nested in raw && !isRecord(raw[nested])) {
      throw new ConfigError(`${nested} must be a JSON object`);
    }
  }
  const nestedFields: Record<string, Set<string>> = {
    i18n: new Set(['library', 'sourceLocale', 'translationFunctionName', 'clientHook', 'serverAsyncFunction', 'messagesPath', 'catalogFormat', 'keyStyle']),
    features: new Set(['sameFileConstants', 'sameFileObjects', 'conditionalStrings', 'templateLiterals', 'stringConcatenation', 'crossFileConstants', 'codemod', 'insertClientTranslations', 'insertServerTranslations']),
    codemod: new Set(['framework'])
  };
  for (const [section, allowed] of Object.entries(nestedFields)) {
    const value = raw[section];
    if (!isRecord(value)) continue;
    const unknownNested = Object.keys(value).filter(key => !allowed.has(key));
    if (unknownNested.length > 0) throw new ConfigError(`Unknown ${section} field(s): ${unknownNested.join(', ')}`);
  }
}

function validateConfig(config: ScannerConfig): void {
  const errors: string[] = [];
  stringArray(config.include, 'include', errors);
  stringArray(config.exclude, 'exclude', errors);
  stringArray(config.checkedAttributes, 'checkedAttributes', errors);
  stringArray(config.ignoredAttributes, 'ignoredAttributes', errors);
  stringArray(config.checkedObjectKeys, 'checkedObjectKeys', errors);
  stringArray(config.ignoredObjectKeys, 'ignoredObjectKeys', errors);
  stringArray(config.allowedStrings, 'allowedStrings', errors);

  if (!isRecord(config.i18n)) errors.push('i18n must be an object');
  else {
    for (const key of [
      'library',
      'sourceLocale',
      'translationFunctionName',
      'clientHook',
      'serverAsyncFunction',
      'messagesPath',
      'keyStyle'
    ] as const) {
      if (typeof config.i18n[key] !== 'string' || config.i18n[key].trim() === '') {
        errors.push(`i18n.${key} must be a non-empty string`);
      }
    }
    if (!['nested-json', 'flat-json'].includes(config.i18n.catalogFormat)) {
      errors.push('i18n.catalogFormat must be nested-json or flat-json');
    }
    if (config.i18n.keyStyle !== 'namespace.dot.camelCase') {
      errors.push('i18n.keyStyle currently supports only namespace.dot.camelCase');
    }
  }

  if (!isRecord(config.checkedComponentProps)) errors.push('checkedComponentProps must be an object');
  else {
    for (const [component, props] of Object.entries(config.checkedComponentProps)) {
      stringArray(props, `checkedComponentProps.${component}`, errors);
    }
  }

  if (!isRecord(config.checkedFunctions)) errors.push('checkedFunctions must be an object');
  else {
    for (const [fn, indices] of Object.entries(config.checkedFunctions)) {
      if (!Array.isArray(indices) || indices.some(index => !Number.isInteger(index) || index < 0)) {
        errors.push(`checkedFunctions.${fn} must be an array of non-negative integers`);
      }
    }
  }

  if (!isRecord(config.commonMappings) || Object.values(config.commonMappings).some(value => typeof value !== 'string')) {
    errors.push('commonMappings must be an object whose values are strings');
  }
  if (config.scanErrors !== undefined && typeof config.scanErrors !== 'boolean') errors.push('scanErrors must be boolean');
  if (config.uiConfigVariables !== undefined) stringArray(config.uiConfigVariables, 'uiConfigVariables', errors);
  if (config.uiConfigTypes !== undefined) stringArray(config.uiConfigTypes, 'uiConfigTypes', errors);

  if (!isRecord(config.features)) errors.push('features must be an object');
  else {
    for (const [name, value] of Object.entries(config.features)) {
      if (typeof value !== 'boolean') errors.push(`features.${name} must be boolean`);
    }
    if (config.features.crossFileConstants) {
      errors.push('features.crossFileConstants is not implemented and must remain false');
    }
  }

  if (config.codemod) {
    if (!isRecord(config.codemod)) errors.push('codemod must be an object');
    const framework = config.codemod.framework;
    if (framework && !['next-intl', 'react-i18next', 'generic'].includes(framework)) {
      errors.push('codemod.framework must be next-intl, react-i18next, or generic');
    }
    if (config.features.codemod && config.i18n.library === 'next-intl' && framework && framework !== 'next-intl') {
      errors.push('codemod.framework must be next-intl when i18n.library is next-intl');
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(`Invalid i18n-scan configuration:\n- ${errors.join('\n- ')}`);
  }
}

export function loadConfig(configPath?: string): ScannerConfig {
  const resolvedPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : path.join(process.cwd(), 'i18n-scan.config.json');

  if (!fs.existsSync(resolvedPath)) {
    if (configPath) throw new ConfigError(`Configuration file not found: ${resolvedPath}`);
    return cloneDefault();
  }

  let loaded: unknown;
  try {
    loaded = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Failed to parse configuration at ${resolvedPath}: ${message}`);
  }

  if (!isRecord(loaded)) {
    throw new ConfigError(`Configuration at ${resolvedPath} must contain a JSON object`);
  }
  validateRawConfig(loaded);

  const base = cloneDefault();
  const merged = {
    ...base,
    ...loaded,
    i18n: { ...base.i18n, ...(isRecord(loaded.i18n) ? loaded.i18n : {}) },
    features: { ...base.features, ...(isRecord(loaded.features) ? loaded.features : {}) },
    codemod: { ...base.codemod, ...(isRecord(loaded.codemod) ? loaded.codemod : {}) }
  } as ScannerConfig;

  validateConfig(merged);
  return merged;
}
