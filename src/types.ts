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
  | 'ErrorString'
  | 'AmbiguousString';

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
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  rawText?: string;
  normalizedText?: string;
  texts?: string[]; // Used for conditional strings containing multiple source choices
  kind: FindingKind;
  confidence: Confidence;
  reason: string;
  userFacingContext?: UserFacingContext;
  suggestedKey?: string;
  suggestedReplacement?: string;
  existingSimilarKey?: string | null;
  duplicateGroupId?: string;
  autoFixCandidate: boolean;
  needsReview: boolean;
  tags?: string[];
  variableName?: string;
  propertyName?: string;
  // For LocalConst/LocalObject: declaration and usage locations
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
}

export interface ScannerConfig {
  include: string[];
  exclude: string[];
  i18n: {
    library: string;
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
    importStatement?: string;
    hookStatement?: string;
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
