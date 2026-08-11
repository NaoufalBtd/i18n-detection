import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fg from 'fast-glob';
import {
  Project,
  SyntaxKind,
  Node,
  VariableDeclarationKind,
  type SourceFile,
  ts
} from 'ts-morph';
import { asArrayLiteral, unwrapExpression } from './ast-utils.js';
import { CacheManager, hashContent } from './cache.js';
import { detectSemanticCandidates } from './semantic-detectors.js';
import { REPORT_SCHEMA_VERSION } from './version.js';
import type {
  ScannerConfig,
  Finding,
  Confidence,
  FindingKind,
  UserFacingContext,
  ScanSummary,
  ScanReport,
  FixStrategy,
  ExpressionKind
} from './types.js';

export interface FileSuppressions {
  fileIgnored: boolean;
  fileIgnoreReason?: string;
  ignoredLines: Set<number>;
  ignoredBlocks: { start: number; end: number; reason?: string }[];
  totalCount: number;
  withoutReasonCount: number;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAtPosition(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= position) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

export function parseSuppressions(content: string): FileSuppressions {
  const starts = lineStarts(content);
  const ignoredLines = new Set<number>();
  const ignoredBlocks: { start: number; end: number; reason?: string }[] = [];
  let fileIgnored = false;
  let fileIgnoreReason: string | undefined;
  let totalCount = 0;
  let withoutReasonCount = 0;
  let activeBlockStart: { line: number; reason?: string } | null = null;

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, content);
  let token = scanner.scan();

  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const tokenStart = scanner.getTokenPos();
      const tokenText = scanner.getTokenText();
      const baseLine = lineAtPosition(starts, tokenStart);
      const commentLines = tokenText.split(/\r?\n/);

      for (let offset = 0; offset < commentLines.length; offset++) {
        const lineText = commentLines[offset];
        const lineNum = baseLine + offset;

        const fileMatch = lineText.match(/\bi18n-scan-ignore-file(?:\s+--\s*(.*))?/);
        if (fileMatch) {
          totalCount++;
          const reason = fileMatch[1]?.trim();
          if (!reason) withoutReasonCount++;
          fileIgnored = true;
          fileIgnoreReason = reason;
        }

        const nextLineMatch = lineText.match(/\bi18n-scan-ignore-next-line(?:\s+--\s*(.*))?/);
        if (nextLineMatch) {
          totalCount++;
          const reason = nextLineMatch[1]?.trim();
          if (!reason) withoutReasonCount++;
          ignoredLines.add(lineNum + 1);
        }

        const startMatch = lineText.match(/\bi18n-scan-ignore-start(?:\s+--\s*(.*))?/);
        if (startMatch) {
          totalCount++;
          const reason = startMatch[1]?.trim();
          if (!reason) withoutReasonCount++;
          if (!activeBlockStart) activeBlockStart = { line: lineNum, reason };
        }

        if (/\bi18n-scan-ignore-end\b/.test(lineText) && activeBlockStart) {
          ignoredBlocks.push({ start: activeBlockStart.line, end: lineNum, reason: activeBlockStart.reason });
          activeBlockStart = null;
        }
      }
    }
    token = scanner.scan();
  }

  if (activeBlockStart) {
    ignoredBlocks.push({ start: activeBlockStart.line, end: starts.length, reason: activeBlockStart.reason });
  }

  return {
    fileIgnored,
    fileIgnoreReason,
    ignoredLines,
    ignoredBlocks,
    totalCount,
    withoutReasonCount
  };
}

interface TracedValue {
  type: 'string' | 'template_literal' | 'concatenation' | 'conditional' | 'object' | 'unknown';
  value?: string;
  texts?: string[];
  node: Node;
  declarationNode?: Node;
  variableName?: string;
  propertyName?: string;
  properties?: Record<string, TracedValue>;
  variables?: string[];
  interpolationExpressions?: Record<string, string>;
}

function camelCase(value: string): string {
  const cleaned = value
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .map((word, index) => {
      if (index === 0) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function getContainingComponentName(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isFunctionDeclaration(current) || Node.isClassDeclaration(current)) {
      const name = current.getName();
      if (name && /^[A-Z]/.test(name)) return name;
    }
    if (Node.isVariableDeclaration(current)) {
      const name = current.getName();
      if (/^[A-Z]/.test(name)) return name;
    }
    current = current.getParent();
  }
  return undefined;
}

function isFunctionScope(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isMethodDeclaration(node)
  );
}

function nearestFunctionScope(node: Node): Node | undefined {
  let current = node.getParent();
  while (current) {
    if (isFunctionScope(current)) return current;
    current = current.getParent();
  }
  return undefined;
}

function expressionPlaceholder(expression: Node, index: number, used: Set<string>): string {
  let base = `value${index}`;
  if (Node.isIdentifier(expression)) base = expression.getText();
  else if (Node.isPropertyAccessExpression(expression)) {
    base = camelCase(`${expression.getExpression().getText()} ${expression.getName()}`) || base;
  }
  base = base.replace(/[^a-zA-Z0-9_$]/g, '') || `value${index}`;
  if (!/^[a-zA-Z_$]/.test(base)) base = `value${index}`;

  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}${suffix++}`;
  used.add(candidate);
  return candidate;
}

const GENERIC_KEY_ROLES = new Set([
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
  'placeholder',
  'actionLabel',
  'ctaLabel',
  'ariaLabel',
  'aria-label'
]);

export class Scanner {
  private readonly config: ScannerConfig;
  private readonly projectRoot: string;
  private readonly project: Project;
  private readonly translationNamespaceCache = new WeakMap<Node, string | null>();

  constructor(config: ScannerConfig, projectRoot = process.cwd()) {
    this.config = config;
    this.projectRoot = path.resolve(projectRoot);
    this.project = new Project({
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.ReactJSX
      }
    });
  }

  private isAllowedString(value: string): boolean {
    return this.config.allowedStrings.includes(value.trim());
  }

  private isPunctuationOnly(value: string): boolean {
    return !/[\p{L}\p{N}]/u.test(value);
  }

  private isNumericOnly(value: string): boolean {
    return /^[-+]?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/.test(value.trim());
  }

  private isCSSValue(value: string): boolean {
    const cssPattern = /^[-+]?(?:\d+|\d*\.\d+)(px|rem|em|vh|vw|%|ms|s)$/i;
    const colorPattern = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const trimmed = value.trim();
    return cssPattern.test(trimmed) || colorPattern.test(trimmed);
  }

  private isHtmlEntityOnly(value: string): boolean {
    return /^(?:&[a-zA-Z0-9#]+;\s*)+$/.test(value.trim());
  }

  private isIgnorable(value: string): boolean {
    const normalized = value.trim();
    return (
      this.isAllowedString(value) ||
      this.isPunctuationOnly(normalized) ||
      this.isNumericOnly(normalized) ||
      this.isCSSValue(normalized) ||
      this.isHtmlEntityOnly(normalized)
    );
  }

  private inferNamespace(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const featureIndex = segments.indexOf('features');
    if (featureIndex >= 0 && segments[featureIndex + 1]) return camelCase(segments[featureIndex + 1]);

    const appIndex = segments.indexOf('app');
    if (appIndex >= 0) {
      for (const segment of segments.slice(appIndex + 1, -1)) {
        if (!segment || segment.startsWith('(') || segment.startsWith('[') || segment.startsWith('@')) continue;
        return camelCase(segment) || 'common';
      }
    }

    const componentIndex = segments.indexOf('components');
    if (componentIndex >= 0 && segments[componentIndex + 1]) {
      const candidate = segments[componentIndex + 1].replace(/\.[jt]sx?$/, '');
      return camelCase(candidate) || 'common';
    }

    const parsed = path.parse(normalized);
    if (parsed.name && parsed.name !== 'index' && parsed.name !== 'page') return camelCase(parsed.name) || 'common';
    return 'common';
  }

  private namespaceForScope(scope: Node): string | undefined {
    if (this.translationNamespaceCache.has(scope)) {
      return this.translationNamespaceCache.get(scope) ?? undefined;
    }

    const namespaces = new Set<string>();
    for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const owner = nearestFunctionScope(call);
      if (Node.isSourceFile(scope)) {
        if (owner) continue;
      } else if (owner !== scope) {
        continue;
      }

      const callee = call.getExpression().getText().replace(/\s+/g, '');
      if (callee === this.config.i18n.clientHook || callee === this.config.i18n.serverAsyncFunction) {
        const firstArg = call.getArguments()[0];
        if (firstArg && Node.isStringLiteral(firstArg)) namespaces.add(firstArg.getLiteralValue());
        continue;
      }
      const configured = this.config.semantic?.translationHooks[callee];
      if (configured) namespaces.add(configured);
    }

    const resolved = namespaces.size === 1 ? [...namespaces][0] : null;
    this.translationNamespaceCache.set(scope, resolved);
    return resolved ?? undefined;
  }

  private inferBoundTranslationNamespace(node: Node): string | undefined {
    const scopes: Node[] = [];
    let current = node.getParent();
    while (current) {
      if (isFunctionScope(current)) scopes.push(current);
      current = current.getParent();
    }
    scopes.push(node.getSourceFile());

    for (const scope of scopes) {
      const namespace = this.namespaceForScope(scope);
      if (namespace) return namespace;
    }
    return undefined;
  }

  private generateSuggestedKey(text: string, namespace: string, contextName?: string, propOrKey?: string): string {
    const trimmed = text.trim();
    if (trimmed in this.config.commonMappings) return this.config.commonMappings[trimmed];

    const context = contextName ? camelCase(contextName) : 'general';
    let semantic: string;
    if (propOrKey && GENERIC_KEY_ROLES.has(propOrKey)) {
      semantic = camelCase(`${trimmed.slice(0, 40)} ${propOrKey}`);
    } else {
      semantic = propOrKey ? camelCase(propOrKey) : camelCase(trimmed.slice(0, 40));
    }
    if (!semantic) semantic = `text${shortHash(trimmed).slice(0, 8)}`;
    return `${namespace}.${context || 'general'}.${semantic}`;
  }

  private generateSuggestedReplacement(key: string, contextType: string, expressions?: Record<string, string>): string {
    const tName = this.config.i18n.translationFunctionName || 't';
    const params = expressions && Object.keys(expressions).length > 0
      ? `, { ${Object.entries(expressions).map(([name, expression]) => `${name}: ${expression}`).join(', ')} }`
      : '';
    const call = `${tName}("${key}"${params})`;
    return contextType === 'JSXText' || contextType === 'JSXAttribute' ? `{${call}}` : call;
  }

  private textVariants(value: TracedValue): string[] {
    if ((value.type === 'string' || value.type === 'template_literal') && value.value) return [value.value];
    if (value.type === 'conditional' && value.texts) return value.texts;
    return [];
  }

  private mergeConditionalObjects(
    left: TracedValue,
    right: TracedValue,
    node: Node
  ): TracedValue | undefined {
    if (left.type !== 'object' || right.type !== 'object') return undefined;
    const properties: Record<string, TracedValue> = {};
    const names = new Set([
      ...Object.keys(left.properties ?? {}),
      ...Object.keys(right.properties ?? {})
    ]);

    for (const name of names) {
      const leftValue = left.properties?.[name];
      const rightValue = right.properties?.[name];
      if (!leftValue) {
        if (rightValue) properties[name] = rightValue;
        continue;
      }
      if (!rightValue) {
        properties[name] = leftValue;
        continue;
      }

      const nested = this.mergeConditionalObjects(leftValue, rightValue, node);
      if (nested) {
        properties[name] = nested;
        continue;
      }

      const texts = [...new Set([
        ...this.textVariants(leftValue),
        ...this.textVariants(rightValue)
      ])];
      if (texts.length > 0) {
        properties[name] = { type: 'conditional', texts, node };
      } else if (leftValue.type !== 'unknown') {
        properties[name] = leftValue;
      } else {
        properties[name] = rightValue;
      }
    }

    return { type: 'object', properties, node };
  }

  private resolveExpression(node: Node, visited = new Set<Node>()): TracedValue {
    if (visited.has(node)) return { type: 'unknown', node };
    visited.add(node);

    const unwrapped = unwrapExpression(node);
    if (unwrapped !== node) return this.resolveExpression(unwrapped, visited);

    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      return { type: 'string', value: node.getLiteralValue(), node };
    }

    if (Node.isTemplateExpression(node)) {
      if (!this.config.features.templateLiterals) return { type: 'unknown', node };
      let value = node.getHead().getLiteralText();
      const variables: string[] = [];
      const interpolationExpressions: Record<string, string> = {};
      const used = new Set<string>();
      node.getTemplateSpans().forEach((span, index) => {
        const expression = span.getExpression();
        const placeholder = expressionPlaceholder(expression, index, used);
        variables.push(placeholder);
        interpolationExpressions[placeholder] = expression.getText();
        value += `{${placeholder}}${span.getLiteral().getLiteralText()}`;
      });
      return { type: 'template_literal', value, variables, interpolationExpressions, node };
    }

    if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getKind();
      if (operator === SyntaxKind.PlusToken) {
        return this.config.features.stringConcatenation
          ? { type: 'concatenation', node }
          : { type: 'unknown', node };
      }
      if (
        this.config.features.conditionalStrings &&
        (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.BarBarToken || operator === SyntaxKind.QuestionQuestionToken)
      ) {
        const left = this.resolveExpression(node.getLeft(), new Set(visited));
        const right = this.resolveExpression(node.getRight(), new Set(visited));
        const object = this.mergeConditionalObjects(left, right, node);
        if (object) return object;
        const texts = [...new Set([
          ...this.textVariants(left),
          ...this.textVariants(right)
        ])];
        if (texts.length > 0) return { type: 'conditional', texts, node };
      }
    }

    if (Node.isConditionalExpression(node)) {
      if (!this.config.features.conditionalStrings) return { type: 'unknown', node };
      const whenTrue = this.resolveExpression(node.getWhenTrue(), new Set(visited));
      const whenFalse = this.resolveExpression(node.getWhenFalse(), new Set(visited));
      const object = this.mergeConditionalObjects(whenTrue, whenFalse, node);
      if (object) return object;
      const texts = [...new Set([
        ...this.textVariants(whenTrue),
        ...this.textVariants(whenFalse)
      ])];
      return { type: 'conditional', texts: texts.length > 0 ? texts : undefined, node };
    }

    if (Node.isIdentifier(node) && this.config.features.sameFileConstants) {
      const definitions = node.getDefinitionNodes();
      if (definitions.length === 1 && Node.isVariableDeclaration(definitions[0])) {
        const declaration = definitions[0];
        const statement = declaration.getVariableStatement();
        if (statement?.getDeclarationKind() === VariableDeclarationKind.Const) {
          const initializer = declaration.getInitializer();
          if (initializer) {
            const resolved = this.resolveExpression(initializer, visited);
            resolved.declarationNode = declaration;
            resolved.variableName = declaration.getName();
            return resolved;
          }
        }
      }
    }

    if (Node.isPropertyAccessExpression(node) && this.config.features.sameFileObjects) {
      const resolvedObject = this.resolveExpression(node.getExpression(), visited);
      const name = node.getName();
      if (resolvedObject.type === 'object' && resolvedObject.properties?.[name]) {
        return { ...resolvedObject.properties[name], propertyName: name };
      }
    }

    if (Node.isObjectLiteralExpression(node) && this.config.features.sameFileObjects) {
      const properties: Record<string, TracedValue> = {};
      for (const property of node.getProperties()) {
        if (!Node.isPropertyAssignment(property)) continue;
        const initializer = property.getInitializer();
        if (initializer) properties[property.getName()] = this.resolveExpression(initializer, new Set(visited));
      }
      return { type: 'object', properties, node };
    }

    return { type: 'unknown', node };
  }

  private isLineSuppressed(line: number, suppressions: FileSuppressions): boolean {
    if (suppressions.fileIgnored || suppressions.ignoredLines.has(line)) return true;
    return suppressions.ignoredBlocks.some(block => line >= block.start && line <= block.end);
  }

  private buildFinding(
    node: Node,
    traced: TracedValue,
    kind: FindingKind,
    confidence: Confidence,
    reason: string,
    context: UserFacingContext,
    relativeFilePath: string,
    suppressions: FileSuppressions,
    semanticRule?: string
  ): Finding | null {
    const sourceFile = node.getSourceFile();
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    let finalConfidence = this.isLineSuppressed(start.line, suppressions) ? 'ignored' : confidence;

    let rawText: string | undefined;
    let normalizedText: string | undefined;
    let texts: string[] | undefined;

    if (traced.type === 'string' && traced.value !== undefined) {
      if (this.isIgnorable(traced.value)) return null;
      rawText = traced.value;
      normalizedText = traced.value.trim().replace(/\s+/g, ' ');
    } else if (traced.type === 'conditional' && traced.texts) {
      texts = traced.texts.filter(text => !this.isIgnorable(text));
      if (texts.length === 0) return null;
      rawText = String(traced.node.getText());
      normalizedText = rawText.trim().replace(/\s+/g, ' ');
    } else {
      rawText = String(traced.node.getText());
      normalizedText = rawText.trim().replace(/\s+/g, ' ');
    }

    let finalKind = kind;
    let declarationLocation: Finding['declarationLocation'];
    let usageLocation: Finding['usageLocation'];
    let expressionKind: ExpressionKind = traced.type === 'string'
      ? 'literal'
      : traced.type === 'template_literal'
        ? 'template'
        : traced.type === 'concatenation'
          ? 'concatenation'
          : traced.type === 'conditional'
            ? 'conditional'
            : 'unknown';

    if (traced.declarationNode) {
      const declarationFile = traced.declarationNode.getSourceFile();
      const declarationStart = declarationFile.getLineAndColumnAtPos(traced.declarationNode.getStart());
      declarationLocation = {
        file: path.relative(this.projectRoot, declarationFile.getFilePath()).replace(/\\/g, '/'),
        line: declarationStart.line,
        column: declarationStart.column
      };
      usageLocation = { file: relativeFilePath, line: start.line, column: start.column };
      expressionKind = traced.propertyName ? 'object-property' : 'constant';
      finalKind = traced.propertyName
        ? 'LocalObjectPropertyUsedInUserFacingContext'
        : 'LocalConstUsedInUserFacingContext';
    }

    if (traced.type === 'template_literal') {
      finalKind = 'TemplateLiteralUsedInUserFacingContext';
      finalConfidence = finalConfidence === 'ignored' ? 'ignored' : 'medium';
      reason = context.type === 'TranslatedLiteralFragment'
        ? 'Template literal mixes translated output with hardcoded literal fragments'
        : 'Template literal requires interpolation/pluralization review';
    } else if (traced.type === 'concatenation') {
      finalKind = 'StringConcatenationUsedInUserFacingContext';
      finalConfidence = finalConfidence === 'ignored' ? 'ignored' : 'medium';
      reason = 'String concatenation requires translation placeholder review';
    } else if (traced.type === 'conditional') {
      finalKind = 'ConditionalStringUsedInUserFacingContext';
      finalConfidence = finalConfidence === 'ignored' ? 'ignored' : 'medium';
      reason = `${reason}; conditional source copy requires review`;
    }

    const namespace = this.inferBoundTranslationNamespace(node) ?? this.inferNamespace(relativeFilePath);
    const containingComponent = getContainingComponentName(node);
    let contextName = 'general';
    if (context.type === 'JSXAttribute' && context.elementName && /^[A-Z]/.test(context.elementName)) {
      contextName = context.elementName;
    } else if (containingComponent) {
      contextName = containingComponent;
    } else {
      contextName = path.basename(relativeFilePath, path.extname(relativeFilePath));
    }

    const propOrKey = context.propName || traced.variableName || traced.propertyName;
    const keySource = texts?.[0] ?? rawText ?? traced.value ?? '';
    const suggestedKey = this.generateSuggestedKey(keySource, namespace, contextName, propOrKey);
    const suggestedReplacement = this.generateSuggestedReplacement(
      suggestedKey,
      context.type,
      traced.interpolationExpressions
    );

    const directLiteral = traced.type === 'string' && !traced.declarationNode;
    const fixStrategy: FixStrategy | undefined =
      directLiteral && finalKind === 'JSXText'
        ? 'replace-jsx-text'
        : directLiteral && (finalKind === 'JSXAttribute' || finalKind === 'KnownComponentProp')
          ? 'replace-jsx-attribute'
          : undefined;
    const autoFixCandidate = finalConfidence === 'high' && Boolean(fixStrategy);
    const fixability = autoFixCandidate ? 'safe' : finalConfidence === 'ignored' ? 'unsupported' : 'review';

    const semanticIdentity = JSON.stringify({
      filePath: relativeFilePath,
      kind: finalKind,
      text: texts ?? normalizedText,
      context,
      variableName: traced.variableName,
      propertyName: traced.propertyName
    });
    const fingerprint = `i18n-v1:${shortHash(semanticIdentity)}`;

    return {
      id: `${relativeFilePath}:${start.line}:${start.column}:${finalKind.toLowerCase()}`,
      fingerprint,
      filePath: relativeFilePath,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      rawText,
      normalizedText,
      texts,
      kind: finalKind,
      rule: semanticRule,
      expressionKind,
      confidence: finalConfidence,
      reason,
      userFacingContext: context,
      suggestedKey,
      suggestedReplacement,
      existingSimilarKey: null,
      duplicateGroupId: `text:${shortHash((texts ?? [normalizedText ?? '']).join('\u0000').toLocaleLowerCase())}`,
      autoFixCandidate,
      fixability,
      fixStrategy,
      needsReview: !autoFixCandidate && finalConfidence !== 'ignored',
      tags: [context.type.toLowerCase(), finalConfidence],
      declarationLocation,
      usageLocation,
      variableName: traced.variableName,
      propertyName: traced.propertyName,
      variables: traced.variables,
      interpolationExpressions: traced.interpolationExpressions
    };
  }

  public scanInMemory(filePath: string, content: string): ScanReport {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(this.projectRoot, filePath);
    this.project.createSourceFile(absolutePath, content, { overwrite: true });
    return this.scanFiles([absolutePath], false);
  }

  private getSource(filePath: string): { sourceFile: SourceFile; content: string; diskBacked: boolean } {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
      return { sourceFile, content, diskBacked: true };
    }
    const existing = this.project.getSourceFile(filePath);
    if (!existing) throw new Error(`Source file not found: ${filePath}`);
    return { sourceFile: existing, content: existing.getFullText(), diskBacked: false };
  }

  public scanFiles(files: string[], useCache = true): ScanReport {
    const findings: Finding[] = [];
    let suppressionsTotal = 0;
    let suppressionsWithoutReason = 0;
    const cache = useCache ? new CacheManager(this.projectRoot, this.config) : null;
    const sortedFiles = [...new Set(files.map(file => path.resolve(file)))].sort();

    for (const filePath of sortedFiles) {
      const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
      const source = this.getSource(filePath);
      const contentDigest = hashContent(source.content);
      const cached = cache?.getEntry(relativePath, contentDigest);
      if (cached) {
        findings.push(...cached.findings);
        suppressionsTotal += cached.suppressions.totalCount;
        suppressionsWithoutReason += cached.suppressions.withoutReasonCount;
        if (source.diskBacked) this.project.removeSourceFile(source.sourceFile);
        continue;
      }

      const sourceFile = source.sourceFile;
      const fileSuppressions = parseSuppressions(source.content);
      suppressionsTotal += fileSuppressions.totalCount;
      suppressionsWithoutReason += fileSuppressions.withoutReasonCount;
      const startIndex = findings.length;

      for (const jsxText of sourceFile.getDescendantsOfKind(SyntaxKind.JsxText)) {
        const parent = jsxText.getParent();
        if (!parent || (!Node.isJsxElement(parent) && !Node.isJsxFragment(parent))) continue;
        const elementName = Node.isJsxElement(parent) ? parent.getOpeningElement().getTagNameNode().getText() : 'Fragment';
        const finding = this.buildFinding(
          jsxText,
          { type: 'string', value: jsxText.getText(), node: jsxText },
          'JSXText',
          'high',
          `Direct JSX text inside ${elementName}`,
          { type: 'JSXText', elementName },
          relativePath,
          fileSuppressions
        );
        if (finding) findings.push(finding);
      }

      for (const jsxExpression of sourceFile.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
        const parent = jsxExpression.getParent();
        if (!parent || (!Node.isJsxElement(parent) && !Node.isJsxFragment(parent))) continue;
        const expression = jsxExpression.getExpression();
        if (!expression) continue;
        const resolved = this.resolveExpression(expression);
        if (resolved.type === 'unknown' || resolved.type === 'object') continue;
        const elementName = Node.isJsxElement(parent) ? parent.getOpeningElement().getTagNameNode().getText() : 'Fragment';
        const finding = this.buildFinding(
          expression,
          resolved,
          'JSXText',
          'high',
          `JSX expression text inside ${elementName}`,
          { type: 'JSXText', elementName },
          relativePath,
          fileSuppressions
        );
        if (finding) findings.push(finding);
      }

      for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
        const propName = attribute.getNameNode().getText();
        const parentElement = attribute.getParent()?.getParent();
        let elementName = 'unknown';
        if (parentElement && (Node.isJsxElement(parentElement) || Node.isJsxSelfClosingElement(parentElement))) {
          const tagNode = Node.isJsxElement(parentElement)
            ? parentElement.getOpeningElement().getTagNameNode()
            : parentElement.getTagNameNode();
          elementName = tagNode.getText();
        }

        const knownComponent = elementName in this.config.checkedComponentProps;
        const knownProp = knownComponent && this.config.checkedComponentProps[elementName].includes(propName);
        const checkedAttribute = this.config.checkedAttributes.includes(propName);
        if (this.config.ignoredAttributes.includes(propName) || (!knownProp && !checkedAttribute)) continue;

        const initializer = attribute.getInitializer();
        if (!initializer) continue;
        let expression: Node = initializer;
        if (Node.isJsxExpression(initializer) && initializer.getExpression()) expression = initializer.getExpression()!;
        const resolved = this.resolveExpression(expression);
        if (resolved.type === 'unknown' || resolved.type === 'object') continue;

        const kind: FindingKind = knownProp ? 'KnownComponentProp' : 'JSXAttribute';
        const confidence: Confidence = knownProp || /^[a-z]/.test(elementName) ? 'high' : 'medium';
        const finding = this.buildFinding(
          expression,
          resolved,
          kind,
          confidence,
          knownProp ? `Known component prop '${propName}' of ${elementName}` : `JSX attribute '${propName}' of ${elementName}`,
          { type: 'JSXAttribute', elementName, propName },
          relativePath,
          fileSuppressions
        );
        if (finding) findings.push(finding);
      }

      if (this.config.features.sameFileObjects) {
        for (const spread of sourceFile.getDescendantsOfKind(SyntaxKind.JsxSpreadAttribute)) {
          const parentElement = spread.getParent()?.getParent();
          let elementName = 'unknown';
          if (parentElement && (Node.isJsxElement(parentElement) || Node.isJsxSelfClosingElement(parentElement))) {
            const tagNode = Node.isJsxElement(parentElement)
              ? parentElement.getOpeningElement().getTagNameNode()
              : parentElement.getTagNameNode();
            elementName = tagNode.getText();
          }
          const resolved = this.resolveExpression(spread.getExpression());
          if (resolved.type !== 'object' || !resolved.properties) continue;

          for (const [propName, propValue] of Object.entries(resolved.properties)) {
            const knownComponent = elementName in this.config.checkedComponentProps;
            const knownProp = knownComponent && this.config.checkedComponentProps[elementName].includes(propName);
            if (this.config.ignoredObjectKeys.includes(propName)) continue;
            if (!knownProp && !this.config.checkedObjectKeys.includes(propName)) continue;
            const finding = this.buildFinding(
              propValue.node,
              propValue,
              'LocalObjectPropertyUsedInUserFacingContext',
              knownProp ? 'high' : 'medium',
              knownProp
                ? `Object property '${propName}' spread into known component ${elementName}`
                : `Object property '${propName}' spread into component ${elementName}`,
              { type: 'JSXAttribute', elementName, propName },
              relativePath,
              fileSuppressions
            );
            if (finding) findings.push(finding);
          }
        }
      }

      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const functionName = call.getExpression().getText().replace(/\s+/g, '');
        const argIndices = this.config.checkedFunctions[functionName];
        if (!argIndices) continue;
        const args = call.getArguments();
        for (const index of argIndices) {
          if (index >= args.length) continue;
          const arg = args[index];
          const resolved = this.resolveExpression(arg);
          if (resolved.type === 'unknown' || resolved.type === 'object') continue;
          const finding = this.buildFinding(
            arg,
            resolved,
            'KnownFunctionArgument',
            'high',
            `Argument index ${index} of function call ${functionName}`,
            { type: 'CallExpression', functionName, argumentIndex: index },
            relativePath,
            fileSuppressions
          );
          if (finding) findings.push(finding);
        }
      }

      if (this.config.features.sameFileObjects) {
        for (const variable of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
          const variableName = variable.getName();
          const typeName = variable.getTypeNode()?.getText() ?? '';
          const initializer = variable.getInitializer();
          const array = initializer ? asArrayLiteral(initializer) : undefined;
          if (!array) continue;
          const recognizedUiConfig =
            this.config.uiConfigVariables?.includes(variableName) || this.config.uiConfigTypes?.includes(typeName);

          for (const element of array.getElements()) {
            const resolved = this.resolveExpression(element);
            if (resolved.type !== 'object' || !resolved.properties) continue;
            for (const [propName, propValue] of Object.entries(resolved.properties)) {
              if (this.config.ignoredObjectKeys.includes(propName) || !this.config.checkedObjectKeys.includes(propName)) continue;
              const finding = this.buildFinding(
                propValue.node,
                propValue,
                'LocalObjectPropertyUsedInUserFacingContext',
                recognizedUiConfig ? 'high' : 'medium',
                `UI configuration object property '${propName}' in array '${variableName}'`,
                { type: 'VariableDeclaration', variableName, propName },
                relativePath,
                fileSuppressions
              );
              if (finding) findings.push(finding);
            }
          }
        }
      }

      for (const candidate of detectSemanticCandidates(sourceFile, relativePath, this.config)) {
        const resolved = this.resolveExpression(candidate.node);
        if (resolved.type === 'unknown' || resolved.type === 'object') continue;
        const finding = this.buildFinding(
          candidate.node,
          resolved,
          candidate.kind,
          candidate.confidence,
          candidate.reason,
          candidate.context,
          relativePath,
          fileSuppressions,
          candidate.rule
        );
        if (!finding) continue;
        finding.translationNamespace = candidate.translationNamespace;
        finding.referencedTranslationKey = candidate.referencedTranslationKey;
        finding.resolvedTranslationKey = candidate.resolvedTranslationKey;
        finding.fallbackValue = candidate.fallbackValue;
        const duplicate = findings.slice(startIndex).some(existing =>
          existing.line === finding.line &&
          existing.column === finding.column &&
          (existing.normalizedText ?? existing.rawText) === (finding.normalizedText ?? finding.rawText)
        );
        if (!duplicate) findings.push(finding);
      }

      if (this.config.scanErrors !== false) {
        for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
          const expression = statement.getExpression();
          if (!expression || !Node.isNewExpression(expression) || expression.getExpression().getText() !== 'Error') continue;
          const firstArg = expression.getArguments()[0];
          if (!firstArg) continue;
          const resolved = this.resolveExpression(firstArg);
          if (resolved.type !== 'string') continue;
          const finding = this.buildFinding(
            firstArg,
            resolved,
            'ErrorString',
            'low',
            'Exception error message',
            { type: 'ThrowStatement' },
            relativePath,
            fileSuppressions
          );
          if (finding) findings.push(finding);
        }
      }

      const fileFindings = findings.slice(startIndex);
      cache?.setEntry(relativePath, contentDigest, fileFindings, {
        totalCount: fileSuppressions.totalCount,
        withoutReasonCount: fileSuppressions.withoutReasonCount
      });
      if (source.diskBacked) this.project.removeSourceFile(sourceFile);
    }

    cache?.save();
    findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));

    const active = findings.filter(finding => finding.confidence !== 'ignored');
    const filesWithFindings = new Set(active.map(finding => finding.filePath));
    const summary: ScanSummary = {
      filesScanned: sortedFiles.length,
      filesWithFindings: filesWithFindings.size,
      totalFindings: active.length,
      highConfidence: active.filter(finding => finding.confidence === 'high').length,
      mediumConfidence: active.filter(finding => finding.confidence === 'medium').length,
      lowConfidence: active.filter(finding => finding.confidence === 'low').length,
      autoFixCandidates: active.filter(finding => finding.autoFixCandidate).length,
      needsReview: active.filter(finding => finding.needsReview).length
    };

    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      projectRoot: this.projectRoot,
      summary,
      suppressions: { total: suppressionsTotal, withoutReason: suppressionsWithoutReason },
      findings
    };
  }

  public async getTargetFiles(): Promise<string[]> {
    const candidates = await fg(this.config.include, {
      ignore: this.config.exclude,
      absolute: true,
      cwd: this.projectRoot,
      onlyFiles: true,
      unique: true
    });

    try {
      const insideGit = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (insideGit !== 'true') return candidates.sort();

      const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
      const allowed = new Set(
        output
          .split('\0')
          .filter(Boolean)
          .map(file => path.resolve(this.projectRoot, file))
      );
      return candidates.filter(file => allowed.has(path.resolve(file))).sort();
    } catch {
      return candidates.sort();
    }
  }
}
