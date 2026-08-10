export type Confidence = 'high' | 'medium' | 'low' | 'ignored';

export type FindingKind =
  | 'JSXText'
  | 'JSXAttribute'
  | 'KnownComponentProp'
  | 'KnownFunctionArgument'
  | 'LocalConstUsedInUserFacingContext'
  | 'LocalObjectPropertyUsedInUserFacingContext'
  | 'ConditionalStringUsedInUserFacingContext'
  | 'TemplateLiteralUsedInUserFacingContext'
  | 'StringConcatenationUsedInUserFacingContext'
  | 'TranslationFallback'
  | 'TranslationDefaultValue'
  | 'PresentationObjectString'
  | 'InlineLocaleCatalogString'
  | 'ValidationMessage'
  | 'NextMetadataString'
  | 'ErrorString'
  | 'AmbiguousString';

export type Fixability = 'safe' | 'review' | 'unsupported';
export type FixStrategy = 'replace-jsx-text' | 'replace-jsx-attribute';

export interface UserFacingContext {
  type: string;
  elementName?: string;
  propName?: string;
  functionName?: string;
  argumentIndex?: number;
  variableName?: string;
}

export interface Finding {
  id: string;
  fingerprint: string;
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  rawText?: string;
  normalizedText?: string;
  texts?: string[];
  kind: FindingKind;
  confidence: Confidence;
  reason: string;
  userFacingContext?: UserFacingContext;
  suggestedKey?: string;
  suggestedReplacement?: string;
  existingSimilarKey?: string | null;
  duplicateGroupId?: string;
  autoFixCandidate: boolean;
  fixability: Fixability;
  fixStrategy?: FixStrategy;
  needsReview: boolean;
  tags?: string[];
  variableName?: string;
  propertyName?: string;
  declarationLocation?: {
    file: string;
    line: number;
    column: number;
  };
  usageLocation?: {
    file: string;
    line: number;
    column: number;
  };
  variables?: string[];
  interpolationExpressions?: Record<string, string>;
}

export type CodemodFramework = 'next-intl' | 'react-i18next' | 'generic';

export interface TranslationApiRule {
  callee: string;
  fallbackArgument?: number;
  optionsArgument?: number;
  defaultValueProperty?: string;
}

export interface SemanticScanConfig {
  translationApis: TranslationApiRule[];
  presentationFilePatterns: string[];
  presentationFunctionPatterns: string[];
  presentationObjectKeys: string[];
  translationObjectVariables: string[];
  inlineLocaleKeys: string[];
  scanValidationMessages: boolean;
  scanNextMetadata: boolean;
}

export interface ScannerConfig {
  include: string[];
  exclude: string[];
  i18n: {
    library: string;
    sourceLocale: string;
    translationFunctionName: string;
    clientHook: string;
    serverAsyncFunction: string;
    messagesPath: string;
    catalogFormat: 'nested-json' | 'flat-json';
    keyStyle: string;
  };
  checkedAttributes: string[];
  ignoredAttributes: string[];
  checkedComponentProps: Record<string, string[]>;
  checkedFunctions: Record<string, number[]>;
  checkedObjectKeys: string[];
  ignoredObjectKeys: string[];
  allowedStrings: string[];
  commonMappings: Record<string, string>;
  scanErrors?: boolean;
  uiConfigVariables?: string[];
  uiConfigTypes?: string[];
  semantic?: SemanticScanConfig;
  features: {
    sameFileConstants: boolean;
    sameFileObjects: boolean;
    conditionalStrings: boolean;
    templateLiterals: boolean;
    stringConcatenation: boolean;
    crossFileConstants: boolean;
    codemod: boolean;
    insertClientTranslations: boolean;
    insertServerTranslations: boolean;
  };
  codemod?: {
    framework?: CodemodFramework;
  };
}

export interface ScanSummary {
  filesScanned: number;
  filesWithFindings: number;
  totalFindings: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  autoFixCandidates: number;
  needsReview: number;
}

export interface SuppressionSummary {
  total: number;
  withoutReason: number;
}

export interface ScanReport {
  schemaVersion: string;
  generatedAt: string;
  projectRoot: string;
  summary: ScanSummary;
  suppressions: SuppressionSummary;
  findings: Finding[];
}
