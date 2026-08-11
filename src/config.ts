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
  include: [
    'src/**/*.{js,jsx,ts,tsx}',
    'apps/*/src/**/*.{js,jsx,ts,tsx}',
    'packages/*/src/**/*.{js,jsx,ts,tsx}'
  ],
  exclude: [
    '**/*.test.{js,jsx,ts,tsx}',
    '**/*.spec.{js,jsx,ts,tsx}',
    '**/*.stories.{js,jsx,ts,tsx}',
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
    requiredLocales: ['en'],
    translationFunctionName: 't',
    clientHook: 'useTranslations',
    serverAsyncFunction: 'getTranslations',
    messagesPath: 'messages/{locale}.json',
    catalogRoutes: [],
    catalogRouting: 'fallback',
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
  semantic: {
    translationApis: [
      { callee: 't', keyArgument: 0, fallbackArgument: 1, optionsArgument: 1, defaultValueProperty: 'defaultValue' },
      { callee: 'translations.t', keyArgument: 0, fallbackArgument: 1 },
      { callee: 'getTranslation', keyArgument: 0, fallbackArgument: 1 }
    ],
    translationHooks: {},
    presentationFilePatterns: [
      'presentation',
      'presenter',
      'adapter',
      'view-model',
      'viewmodel',
      'translations',
      'columns'
    ],
    presentationFunctionPatterns: [
      '^get.*Presentation$',
      '^adapt',
      '^map.*Presentation$',
      '^use.*Translations$',
      '^get.*Columns$'
    ],
    presentationObjectKeys: [
      'title',
      'subtitle',
      'description',
      'label',
      'defaultLabel',
      'message',
      'helperText',
      'emptyText',
      'header',
      'footer',
      'caption',
      'tooltip',
      'placeholder',
      'actionLabel',
      'ctaLabel',
      'primary',
      'secondary'
    ],
    translationObjectVariables: ['labels', 'copy', 'messages', 'translations'],
    presentationInclude: ['src/', 'apps/web/'],
    staticRegistryVariablePatterns: [
      '(_OPTIONS|_STATES|_DEFINITIONS|_COPY|_LABELS)$',
      '^(OPTIONS|STATES|DEFINITIONS|COPY|LABELS)$'
    ],
    staticRegistryObjectKeys: [
      'title',
      'subtitle',
      'description',
      'label',
      'defaultLabel',
      'message',
      'helperText',
      'emptyText',
      'caption',
      'tooltip',
      'placeholder',
      'actionLabel',
      'ctaLabel'
    ],
    staticRegistryInclude: ['src/', 'apps/web/', 'packages/contracts/'],
    inlineLocaleKeys: ['en', 'fr', 'ar'],
    validationInclude: ['src/', 'apps/web/', 'packages/contracts/'],
    schemaDefaultKeys: [
      'title',
      'subtitle',
      'description',
      'label',
      'defaultLabel',
      'message',
      'helperText',
      'emptyText',
      'caption',
      'tooltip',
      'placeholder',
      'actionLabel',
      'ctaLabel',
      'guidedPrompt',
      'reassurance',
      'eyebrow',
      'body'
    ],
    scanSchemaDefaults: true,
    scanValidationMessages: true,
    scanNextMetadata: true
  },
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
    framework: 'next-intl',
    requireProjectValidation: false
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

function stringRecord(value: unknown, name: string, errors: string[]): void {
  if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'string')) {
    errors.push(`${name} must be an object whose values are strings`);
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
    'semantic',
    'features',
    'codemod'
  ]);
  const unknown = Object.keys(raw).filter(key => !allowedTopLevel.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`Unknown configuration field(s): ${unknown.join(', ')}`);
  }

  for (const nested of ['i18n', 'semantic', 'features', 'codemod'] as const) {
    if (nested in raw && !isRecord(raw[nested])) {
      throw new ConfigError(`${nested} must be a JSON object`);
    }
  }

  const nestedFields: Record<string, Set<string>> = {
    i18n: new Set([
      'library',
      'sourceLocale',
      'requiredLocales',
      'translationFunctionName',
      'clientHook',
      'serverAsyncFunction',
      'messagesPath',
      'catalogRoutes',
      'catalogRouting',
      'catalogFormat',
      'keyStyle'
    ]),
    semantic: new Set([
      'translationApis',
      'translationHooks',
      'presentationFilePatterns',
      'presentationFunctionPatterns',
      'presentationObjectKeys',
      'translationObjectVariables',
      'presentationInclude',
      'staticRegistryVariablePatterns',
      'staticRegistryObjectKeys',
      'staticRegistryInclude',
      'inlineLocaleKeys',
      'validationInclude',
      'schemaDefaultKeys',
      'scanSchemaDefaults',
      'scanValidationMessages',
      'scanNextMetadata'
    ]),
    features: new Set([
      'sameFileConstants',
      'sameFileObjects',
      'conditionalStrings',
      'templateLiterals',
      'stringConcatenation',
      'crossFileConstants',
      'codemod',
      'insertClientTranslations',
      'insertServerTranslations'
    ]),
    codemod: new Set(['framework', 'tsconfigPath', 'requireProjectValidation'])
  };

  for (const [section, allowed] of Object.entries(nestedFields)) {
    const value = raw[section];
    if (!isRecord(value)) continue;
    const unknownNested = Object.keys(value).filter(key => !allowed.has(key));
    if (unknownNested.length > 0) {
      throw new ConfigError(`Unknown ${section} field(s): ${unknownNested.join(', ')}`);
    }
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

    stringArray(config.i18n.requiredLocales, 'i18n.requiredLocales', errors);
    if (Array.isArray(config.i18n.requiredLocales)) {
      if (!config.i18n.requiredLocales.includes(config.i18n.sourceLocale)) {
        errors.push('i18n.requiredLocales must include i18n.sourceLocale');
      }
      if (new Set(config.i18n.requiredLocales).size !== config.i18n.requiredLocales.length) {
        errors.push('i18n.requiredLocales must not contain duplicates');
      }
    }

    if (!['fallback', 'strict'].includes(config.i18n.catalogRouting)) {
      errors.push('i18n.catalogRouting must be fallback or strict');
    }
    if (!['nested-json', 'flat-json'].includes(config.i18n.catalogFormat)) {
      errors.push('i18n.catalogFormat must be nested-json or flat-json');
    }
    if (config.i18n.keyStyle !== 'namespace.dot.camelCase') {
      errors.push('i18n.keyStyle currently supports only namespace.dot.camelCase');
    }

    if (config.i18n.catalogRoutes !== undefined) {
      if (!Array.isArray(config.i18n.catalogRoutes)) {
        errors.push('i18n.catalogRoutes must be an array');
      } else {
        const namespaces = new Set<string>();
        for (const [index, route] of config.i18n.catalogRoutes.entries()) {
          if (!isRecord(route)) {
            errors.push(`i18n.catalogRoutes.${index} must be an object`);
            continue;
          }
          const unknownRoute = Object.keys(route).filter(key => !['namespace', 'messagesPath', 'stripNamespace'].includes(key));
          if (unknownRoute.length > 0) {
            errors.push(`i18n.catalogRoutes.${index} contains unknown field(s): ${unknownRoute.join(', ')}`);
          }
          if (typeof route.namespace !== 'string' || route.namespace.trim() === '') {
            errors.push(`i18n.catalogRoutes.${index}.namespace must be a non-empty string`);
          } else if (namespaces.has(route.namespace)) {
            errors.push(`i18n.catalogRoutes contains duplicate namespace '${route.namespace}'`);
          } else {
            namespaces.add(route.namespace);
          }
          if (typeof route.messagesPath !== 'string' || route.messagesPath.trim() === '') {
            errors.push(`i18n.catalogRoutes.${index}.messagesPath must be a non-empty string`);
          }
          if (route.stripNamespace !== undefined && typeof route.stripNamespace !== 'boolean') {
            errors.push(`i18n.catalogRoutes.${index}.stripNamespace must be boolean`);
          }
        }
      }
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

  stringRecord(config.commonMappings, 'commonMappings', errors);
  if (config.scanErrors !== undefined && typeof config.scanErrors !== 'boolean') errors.push('scanErrors must be boolean');
  if (config.uiConfigVariables !== undefined) stringArray(config.uiConfigVariables, 'uiConfigVariables', errors);
  if (config.uiConfigTypes !== undefined) stringArray(config.uiConfigTypes, 'uiConfigTypes', errors);

  if (config.semantic) {
    if (!isRecord(config.semantic)) errors.push('semantic must be an object');
    else {
      stringRecord(config.semantic.translationHooks, 'semantic.translationHooks', errors);
      stringArray(config.semantic.presentationFilePatterns, 'semantic.presentationFilePatterns', errors);
      stringArray(config.semantic.presentationFunctionPatterns, 'semantic.presentationFunctionPatterns', errors);
      stringArray(config.semantic.presentationObjectKeys, 'semantic.presentationObjectKeys', errors);
      stringArray(config.semantic.translationObjectVariables, 'semantic.translationObjectVariables', errors);
      stringArray(config.semantic.presentationInclude, 'semantic.presentationInclude', errors);
      stringArray(config.semantic.staticRegistryVariablePatterns, 'semantic.staticRegistryVariablePatterns', errors);
      stringArray(config.semantic.staticRegistryObjectKeys, 'semantic.staticRegistryObjectKeys', errors);
      stringArray(config.semantic.staticRegistryInclude, 'semantic.staticRegistryInclude', errors);
      stringArray(config.semantic.inlineLocaleKeys, 'semantic.inlineLocaleKeys', errors);
      stringArray(config.semantic.validationInclude, 'semantic.validationInclude', errors);
      stringArray(config.semantic.schemaDefaultKeys, 'semantic.schemaDefaultKeys', errors);

      if (typeof config.semantic.scanSchemaDefaults !== 'boolean') errors.push('semantic.scanSchemaDefaults must be boolean');
      if (typeof config.semantic.scanValidationMessages !== 'boolean') errors.push('semantic.scanValidationMessages must be boolean');
      if (typeof config.semantic.scanNextMetadata !== 'boolean') errors.push('semantic.scanNextMetadata must be boolean');

      if (!Array.isArray(config.semantic.translationApis)) {
        errors.push('semantic.translationApis must be an array');
      } else {
        for (const [index, rule] of config.semantic.translationApis.entries()) {
          if (!isRecord(rule) || typeof rule.callee !== 'string' || rule.callee.trim() === '') {
            errors.push(`semantic.translationApis.${index}.callee must be a non-empty string`);
            continue;
          }
          const unknownRule = Object.keys(rule).filter(key => ![
            'callee',
            'keyArgument',
            'fallbackArgument',
            'optionsArgument',
            'defaultValueProperty'
          ].includes(key));
          if (unknownRule.length > 0) {
            errors.push(`semantic.translationApis.${index} contains unknown field(s): ${unknownRule.join(', ')}`);
          }
          for (const field of ['keyArgument', 'fallbackArgument', 'optionsArgument'] as const) {
            const value = rule[field];
            if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
              errors.push(`semantic.translationApis.${index}.${field} must be a non-negative integer`);
            }
          }
          if (rule.defaultValueProperty !== undefined && (typeof rule.defaultValueProperty !== 'string' || rule.defaultValueProperty.trim() === '')) {
            errors.push(`semantic.translationApis.${index}.defaultValueProperty must be a non-empty string`);
          }
        }
      }

      for (const [name, patterns] of [
        ['semantic.presentationFunctionPatterns', config.semantic.presentationFunctionPatterns],
        ['semantic.staticRegistryVariablePatterns', config.semantic.staticRegistryVariablePatterns]
      ] as const) {
        for (const [index, pattern] of patterns.entries()) {
          try {
            new RegExp(pattern);
          } catch {
            errors.push(`${name}.${index} must be a valid regular expression`);
          }
        }
      }
    }
  }

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
    if (config.codemod.tsconfigPath !== undefined && (typeof config.codemod.tsconfigPath !== 'string' || config.codemod.tsconfigPath.trim() === '')) {
      errors.push('codemod.tsconfigPath must be a non-empty string when provided');
    }
    if (config.codemod.requireProjectValidation !== undefined && typeof config.codemod.requireProjectValidation !== 'boolean') {
      errors.push('codemod.requireProjectValidation must be boolean');
    }
    if (config.codemod.requireProjectValidation && !config.codemod.tsconfigPath) {
      errors.push('codemod.tsconfigPath is required when codemod.requireProjectValidation=true');
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
    semantic: { ...base.semantic, ...(isRecord(loaded.semantic) ? loaded.semantic : {}) },
    features: { ...base.features, ...(isRecord(loaded.features) ? loaded.features : {}) },
    codemod: { ...base.codemod, ...(isRecord(loaded.codemod) ? loaded.codemod : {}) }
  } as ScannerConfig;

  validateConfig(merged);
  return merged;
}
