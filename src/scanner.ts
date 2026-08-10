import * as path from 'node:path';
import * as fs from 'node:fs';
import { CacheManager } from './cache.js';
import fg from 'fast-glob';
import {
  Project,
  SyntaxKind,
  Node,
  VariableDeclarationKind,
  JsxText,
  JsxAttribute,
  JsxSpreadAttribute,
  CallExpression,
  VariableDeclaration,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  ThrowStatement,
  NewExpression,
  Expression,
  SourceFile
} from 'ts-morph';
import type {
  ScannerConfig,
  Finding,
  Confidence,
  FindingKind,
  UserFacingContext,
  ScanSummary,
  SuppressionSummary,
  ScanReport
} from './types.js';

export interface FileSuppressions {
  fileIgnored: boolean;
  fileIgnoreReason?: string;
  ignoredLines: Set<number>;
  ignoredBlocks: { start: number; end: number; reason?: string }[];
  totalCount: number;
  withoutReasonCount: number;
}

export function parseSuppressions(content: string): FileSuppressions {
  const lines = content.split(/\r?\n/);
  const ignoredLines = new Set<number>();
  const ignoredBlocks: { start: number; end: number; reason?: string }[] = [];
  let fileIgnored = false;
  let fileIgnoreReason: string | undefined;

  let totalCount = 0;
  let withoutReasonCount = 0;

  let activeBlockStart: { line: number; reason?: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineNum = i + 1;

    // 1. File ignore
    const fileMatch = lineText.match(/i18n-scan-ignore-file(?:\s+--(.*))?/);
    if (fileMatch) {
      totalCount++;
      const reason = fileMatch[1]?.trim();
      if (!reason) {
        withoutReasonCount++;
      }
      fileIgnored = true;
      fileIgnoreReason = reason;
    }

    // 2. Next line ignore
    const nextLineMatch = lineText.match(/i18n-scan-ignore-next-line(?:\s+--(.*))?/);
    if (nextLineMatch) {
      totalCount++;
      const reason = nextLineMatch[1]?.trim();
      if (!reason) {
        withoutReasonCount++;
      }
      ignoredLines.add(lineNum + 1);
    }

    // 3. Block ignore start
    const startMatch = lineText.match(/i18n-scan-ignore-start(?:\s+--(.*))?/);
    if (startMatch) {
      totalCount++;
      const reason = startMatch[1]?.trim();
      if (!reason) {
        withoutReasonCount++;
      }
      activeBlockStart = { line: lineNum, reason };
    }

    // 4. Block ignore end
    const endMatch = lineText.match(/i18n-scan-ignore-end/);
    if (endMatch) {
      if (activeBlockStart) {
        ignoredBlocks.push({
          start: activeBlockStart.line,
          end: lineNum,
          reason: activeBlockStart.reason
        });
        activeBlockStart = null;
      }
    }
  }

  if (activeBlockStart) {
    ignoredBlocks.push({
      start: activeBlockStart.line,
      end: lines.length,
      reason: activeBlockStart.reason
    });
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
}

function camelCase(str: string): string {
  const cleaned = str
    .replace(/[^a-zA-Z0-9\s-_]/g, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .map((word, index) => {
      if (index === 0) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function getContainingComponentName(node: Node): string | undefined {
  let curr: Node | undefined = node;
  while (curr) {
    if (Node.isFunctionDeclaration(curr) || Node.isClassDeclaration(curr)) {
      const name = curr.getName();
      if (name && name[0] === name[0].toUpperCase()) {
        return name;
      }
    }
    if (Node.isVariableDeclaration(curr)) {
      const name = curr.getName();
      if (name && name[0] === name[0].toUpperCase()) {
        return name;
      }
    }
    curr = curr.getParent();
  }
  return undefined;
}

export class Scanner {
  private config: ScannerConfig;
  private projectRoot: string;
  private project: Project;

  constructor(config: ScannerConfig, projectRoot = process.cwd()) {
    this.config = config;
    this.projectRoot = projectRoot;
    this.project = new Project({
      compilerOptions: {
        allowJs: true,
        jsx: 1 // React
      }
    });
  }

  private isAllowedString(str: string): boolean {
    return this.config.allowedStrings.includes(str.trim());
  }

  private isPunctuationOnly(str: string): boolean {
    return !/[\p{L}\p{N}]/u.test(str);
  }

  private isNumericOnly(str: string): boolean {
    return /^[-+]?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/.test(str.trim());
  }

  private isCSSValue(str: string): boolean {
    const cssPattern = /^[-+]?(?:\d+|\d*\.\d+)(px|rem|em|vh|vw|%|ms|s)$/i;
    const colorPattern = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const strTrim = str.trim();
    return cssPattern.test(strTrim) || colorPattern.test(strTrim);
  }

  private isHtmlEntityOnly(str: string): boolean {
    return /^(?:&[a-zA-Z0-9#]+;\s*)+$/.test(str.trim());
  }

  private inferNamespace(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, '/');

    const featureMatch = normalizedPath.match(/src\/features\/([^/]+)/);
    if (featureMatch) return featureMatch[1].toLowerCase();

    const routeMatch = normalizedPath.match(/src\/app\/([^/]+)/);
    if (routeMatch) return routeMatch[1].toLowerCase();

    const componentMatch = normalizedPath.match(/src\/components\/([^/]+)/);
    if (componentMatch) return componentMatch[1].replace(/\.[jt]sx?$/, '').toLowerCase();

    const parsed = path.parse(normalizedPath);
    if (parsed.name && parsed.name !== 'index' && parsed.name !== 'page') {
      return parsed.name.toLowerCase();
    }
    return 'common';
  }

  private generateSuggestedKey(text: string, namespace: string, contextName?: string, propOrKey?: string): string {
    const trimmed = text.trim();
    if (this.config.commonMappings && trimmed in this.config.commonMappings) {
      return this.config.commonMappings[trimmed];
    }

    const fileOrComponent = contextName ? camelCase(contextName) : 'general';
    let semantic = propOrKey ? camelCase(propOrKey) : camelCase(trimmed.slice(0, 20));
    if (!semantic) {
      semantic = 'text_' + Math.abs(hashCode(trimmed));
    }

    return `${namespace}.${fileOrComponent}.${semantic}`;
  }

  private generateSuggestedReplacement(key: string, contextType: string, variables?: string[]): string {
    const tFuncName = this.config.i18n.translationFunctionName || 't';
    let varObj = '';
    if (variables && variables.length > 0) {
      varObj = `, { ${variables.join(', ')} }`;
    }
    if (contextType === 'JSXText' || contextType === 'JSXAttribute') {
      return `{${tFuncName}("${key}"${varObj})}`;
    }
    return `${tFuncName}("${key}"${varObj})`;
  }

  private resolveExpression(node: Node, visited = new Set<Node>()): TracedValue {
    if (visited.has(node)) {
      return { type: 'unknown', node };
    }
    visited.add(node);

    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      return {
        type: 'string',
        value: node.getLiteralValue(),
        node
      };
    }

    if (Node.isTemplateExpression(node)) {
      const head = node.getHead().getLiteralText();
      const templateSpans = node.getTemplateSpans();
      let value = head;
      const variables: string[] = [];
      
      for (const span of templateSpans) {
        const expression = span.getExpression();
        let varName = `var${variables.length}`;
        if (Node.isIdentifier(expression)) {
          varName = expression.getText();
        } else if (Node.isPropertyAccessExpression(expression)) {
          varName = expression.getName();
        }
        variables.push(varName);
        value += `{{${varName}}}`;
        value += span.getLiteral().getLiteralText();
      }

      return {
        type: 'template_literal',
        value,
        variables,
        node
      };
    }

    if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getKind();
      if (operator === SyntaxKind.PlusToken) {
        return {
          type: 'concatenation',
          node
        };
      }
    }

    if (Node.isConditionalExpression(node)) {
      const whenTrue = this.resolveExpression(node.getWhenTrue(), visited);
      const whenFalse = this.resolveExpression(node.getWhenFalse(), visited);
      const texts: string[] = [];
      if (whenTrue.type === 'string' && whenTrue.value) texts.push(whenTrue.value);
      if (whenTrue.type === 'conditional' && whenTrue.texts) texts.push(...whenTrue.texts);
      if (whenFalse.type === 'string' && whenFalse.value) texts.push(whenFalse.value);
      if (whenFalse.type === 'conditional' && whenFalse.texts) texts.push(...whenFalse.texts);

      return {
        type: 'conditional',
        texts: texts.length > 0 ? texts : undefined,
        node
      };
    }

    if (Node.isIdentifier(node)) {
      const defs = node.getDefinitionNodes();
      if (defs.length === 1) {
        const def = defs[0];
        if (Node.isVariableDeclaration(def)) {
          const statement = def.getVariableStatement();
          if (statement && statement.getDeclarationKind() === VariableDeclarationKind.Const) {
            const initializer = def.getInitializer();
            if (initializer) {
              const resolved = this.resolveExpression(initializer, visited);
              resolved.declarationNode = def;
              resolved.variableName = def.getName();
              return resolved;
            }
          }
        }
      }
    }

    if (Node.isPropertyAccessExpression(node)) {
      const expression = node.getExpression();
      const name = node.getName();
      const resolvedObj = this.resolveExpression(expression, visited);
      if (resolvedObj.type === 'object' && resolvedObj.properties && resolvedObj.properties[name]) {
        const resolvedProp = { ...resolvedObj.properties[name] };
        resolvedProp.propertyName = name;
        return resolvedProp;
      }
    }

    if (Node.isObjectLiteralExpression(node)) {
      const properties: Record<string, TracedValue> = {};
      for (const prop of node.getProperties()) {
        if (Node.isPropertyAssignment(prop)) {
          const name = prop.getName();
          const initializer = prop.getInitializer();
          if (initializer) {
            properties[name] = this.resolveExpression(initializer, visited);
          }
        }
      }
      return {
        type: 'object',
        properties,
        node
      };
    }

    return {
      type: 'unknown',
      node
    };
  }

  private isLineSuppressed(line: number, suppressions: FileSuppressions): boolean {
    if (suppressions.fileIgnored) return true;
    if (suppressions.ignoredLines.has(line)) return true;
    for (const block of suppressions.ignoredBlocks) {
      if (line >= block.start && line <= block.end) return true;
    }
    return false;
  }

  private buildFinding(
    node: Node,
    traced: TracedValue,
    kind: FindingKind,
    confidence: Confidence,
    reason: string,
    context: UserFacingContext,
    relativeFilePath: string,
    suppressions: FileSuppressions
  ): Finding | null {
    const sourceFile = node.getSourceFile();
    const startPos = node.getStart();
    const endPos = node.getEnd();
    const lc = sourceFile.getLineAndColumnAtPos(startPos);
    const endLc = sourceFile.getLineAndColumnAtPos(endPos);

    let finalConfidence = confidence;
    if (this.isLineSuppressed(lc.line, suppressions)) {
      finalConfidence = 'ignored';
    }

    // Determine raw and normalized texts
    let rawText: string | undefined;
    let normalizedText: string | undefined;
    let texts: string[] | undefined;

    if (traced.type === 'string' && traced.value !== undefined) {
      rawText = traced.value;
      normalizedText = traced.value.trim().replace(/\s+/g, ' ');
      if (
        this.isAllowedString(rawText) ||
        this.isPunctuationOnly(normalizedText) ||
        this.isNumericOnly(normalizedText) ||
        this.isCSSValue(normalizedText) ||
        this.isHtmlEntityOnly(normalizedText)
      ) {
        return null;
      }
    } else if (traced.type === 'conditional' && traced.texts) {
      texts = traced.texts.filter(
        t =>
          !this.isAllowedString(t) &&
          !this.isPunctuationOnly(t) &&
          !this.isNumericOnly(t) &&
          !this.isCSSValue(t) &&
          !this.isHtmlEntityOnly(t)
      );
      if (texts.length === 0) return null;
      rawText = traced.node.getText();
      normalizedText = rawText.trim().replace(/\s+/g, ' ');
    } else {
      rawText = traced.node.getText();
      normalizedText = rawText.trim().replace(/\s+/g, ' ');
    }

    // Adjust kind if resolved from local const or object property
    let finalKind = kind;
    let declLoc: { file: string; line: number; column: number } | undefined;
    let usageLoc: { file: string; line: number; column: number } | undefined;

    if (traced.declarationNode) {
      const dFile = traced.declarationNode.getSourceFile();
      const dStart = traced.declarationNode.getStart();
      const dLc = dFile.getLineAndColumnAtPos(dStart);
      const dRelPath = path.relative(this.projectRoot, dFile.getFilePath()).replace(/\\/g, '/');

      declLoc = {
        file: dRelPath,
        line: dLc.line,
        column: dLc.column
      };

      usageLoc = {
        file: relativeFilePath,
        line: lc.line,
        column: lc.column
      };

      if (traced.propertyName) {
        finalKind = 'LocalObjectPropertyUsedInUserFacingContext';
      } else {
        finalKind = 'LocalConstUsedInUserFacingContext';
      }
    }

    // Check dynamic kinds (template literals & concatenations)
    if (traced.type === 'template_literal') {
      finalKind = 'TemplateLiteralUsedInUserFacingContext';
      if (traced.variables && traced.variables.length > 0) {
        finalConfidence = 'high';
        reason = 'Template literal extracted with variables';
      } else {
        finalConfidence = 'medium';
        reason = 'Template literal may require interpolation and pluralization';
      }
    } else if (traced.type === 'concatenation') {
      finalKind = 'StringConcatenationUsedInUserFacingContext';
      finalConfidence = 'medium';
      reason = 'String concatenation may require translation placeholders';
    } else if (traced.type === 'conditional') {
      finalKind = 'ConditionalStringUsedInUserFacingContext';
      finalConfidence = 'medium';
      reason = 'Conditional expression contains multiple hardcoded strings';
    }

    // Key generation
    const namespace = this.inferNamespace(relativeFilePath);

    // Determine containing React component name or file name
    const containingComponent = getContainingComponentName(node);
    let fileOrComponent = 'general';
    if (context.type === 'JSXAttribute' && context.elementName && context.elementName[0] === context.elementName[0].toUpperCase()) {
      fileOrComponent = context.elementName;
    } else if (containingComponent) {
      fileOrComponent = containingComponent;
    } else {
      fileOrComponent = path.basename(relativeFilePath, path.extname(relativeFilePath));
    }

    let propOrKey = context.propName || traced.variableName || traced.propertyName;
    const suggestedKey = this.generateSuggestedKey(texts ? texts[0] : (rawText || ''), namespace, fileOrComponent, propOrKey);
    const suggestedReplacement = this.generateSuggestedReplacement(suggestedKey, context.type, traced.variables);

    const isAutoFix =
      finalConfidence === 'high' &&
      finalKind !== 'ConditionalStringUsedInUserFacingContext' &&
      finalKind !== 'StringConcatenationUsedInUserFacingContext' &&
      finalKind !== 'ErrorString';

    return {
      id: `${relativeFilePath}:${lc.line}:${lc.column}:${finalKind.toLowerCase().replace(/usedinuserfacingcontext/g, '')}`,
      filePath: relativeFilePath,
      line: lc.line,
      column: lc.column,
      endLine: endLc.line,
      endColumn: endLc.column,
      rawText,
      normalizedText,
      texts,
      kind: finalKind,
      confidence: finalConfidence,
      reason,
      userFacingContext: context,
      suggestedKey,
      suggestedReplacement,
      existingSimilarKey: null,
      duplicateGroupId: `text:${(normalizedText || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      autoFixCandidate: isAutoFix,
      needsReview: !isAutoFix,
      tags: [context.type.toLowerCase(), finalConfidence],
      declarationLocation: declLoc,
      usageLocation: usageLoc,
      variableName: traced.variableName,
      propertyName: traced.propertyName,
      variables: traced.variables
    };
  }

  public scanInMemory(filePath: string, content: string): ScanReport {
    this.project.createSourceFile(filePath, content, { overwrite: true });
    return this.scanFiles([filePath]);
  }

  public scanFiles(files: string[], useCache = true): ScanReport {
    const findings: Finding[] = [];
    let suppressionsTotal = 0;
    let suppressionsWithoutReason = 0;

    const cacheManager = useCache ? new CacheManager(this.projectRoot) : null;

    for (const filePath of files) {
      const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');

      let stat: fs.Stats | null = null;
      if (cacheManager) {
        try {
          stat = fs.statSync(filePath);
          const cached = cacheManager.getEntry(relativePath, stat.mtimeMs);
          if (cached) {
            findings.push(...cached.findings);
            suppressionsTotal += cached.suppressions.totalCount;
            suppressionsWithoutReason += cached.suppressions.withoutReasonCount;
            continue;
          }
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            console.error('STAT_ERROR:', e.message, filePath);
          }
        }
      }

      let sourceFile = this.project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = this.project.addSourceFileAtPath(filePath);
      }
      const content = sourceFile.getFullText();

      const fileSup = parseSuppressions(content);
      suppressionsTotal += fileSup.totalCount;
      suppressionsWithoutReason += fileSup.withoutReasonCount;

      const startIndex = findings.length;

      // 1. Direct JSX Text
      const jsxTexts = sourceFile.getDescendantsOfKind(SyntaxKind.JsxText);
      for (const jsxText of jsxTexts) {
        const parent = jsxText.getParent();
        let elementName = 'JSXElement';
        if (parent && (Node.isJsxElement(parent) || Node.isJsxSelfClosingElement(parent))) {
          const tagNode = Node.isJsxElement(parent)
            ? parent.getOpeningElement().getTagNameNode()
            : parent.getTagNameNode();
          elementName = tagNode.getText();
        }

        const traced: TracedValue = {
          type: 'string',
          value: jsxText.getText(),
          node: jsxText
        };

        const f = this.buildFinding(
          jsxText,
          traced,
          'JSXText',
          'high',
          `Direct JSX text inside ${elementName}`,
          { type: 'JSXText', elementName },
          relativePath,
          fileSup
        );
        if (f) findings.push(f);
      }

      // 1b. JSX Expression Text (e.g. <h1>{title}</h1> where title is a local constant)
      const jsxExprs = sourceFile.getDescendantsOfKind(SyntaxKind.JsxExpression);
      for (const jsxExpr of jsxExprs) {
        const parent = jsxExpr.getParent();
        if (parent && (Node.isJsxElement(parent) || Node.isJsxSelfClosingElement(parent))) {
          const inner = jsxExpr.getExpression();
          if (inner) {
            const resolved = this.resolveExpression(inner);
            if (resolved.type === 'unknown' || resolved.type === 'object') continue;

            const tagNode = Node.isJsxElement(parent)
              ? parent.getOpeningElement().getTagNameNode()
              : parent.getTagNameNode();
            const elementName = tagNode.getText();

            const f = this.buildFinding(
              inner,
              resolved,
              'JSXText',
              'high',
              `JSX expression text inside ${elementName}`,
              { type: 'JSXText', elementName },
              relativePath,
              fileSup
            );
            if (f) findings.push(f);
          }
        }
      }

      // 2. JSX Attributes (including component props)
      const jsxAttrs = sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute);
      for (const attr of jsxAttrs) {
        const propName = attr.getNameNode().getText();
        const parentElement = attr.getParent()?.getParent();
        let elementName = 'unknown';
        if (parentElement && (Node.isJsxElement(parentElement) || Node.isJsxSelfClosingElement(parentElement))) {
          const tagNode = Node.isJsxElement(parentElement)
            ? parentElement.getOpeningElement().getTagNameNode()
            : parentElement.getTagNameNode();
          elementName = tagNode.getText();
        }

        const isKnownComponent = elementName in this.config.checkedComponentProps;
        const isKnownProp = isKnownComponent && this.config.checkedComponentProps[elementName].includes(propName);
        const isCheckedAttr = this.config.checkedAttributes.includes(propName);
        const isIgnoredAttr = this.config.ignoredAttributes.includes(propName);

        if (isIgnoredAttr) continue;
        if (!isKnownProp && !isCheckedAttr) continue;

        const initializer = attr.getInitializer();
        if (!initializer) continue;

        let expr: Node = initializer;
        if (Node.isJsxExpression(initializer)) {
          const innerExpr = initializer.getExpression();
          if (innerExpr) expr = innerExpr;
        }

        const resolved = this.resolveExpression(expr);
        if (resolved.type === 'unknown' || resolved.type === 'object') continue;

        const kind: FindingKind = isKnownProp ? 'KnownComponentProp' : 'JSXAttribute';
        const confidence: Confidence = isKnownProp
          ? 'high'
          : elementName[0] === elementName[0].toLowerCase()
          ? 'high'
          : 'medium'; // Custom component with generic user-facing prop name

        const reason = isKnownProp
          ? `Known component prop '${propName}' of ${elementName}`
          : `JSX attribute '${propName}' of ${elementName}`;

        const f = this.buildFinding(
          expr,
          resolved,
          kind,
          confidence,
          reason,
          { type: 'JSXAttribute', elementName, propName },
          relativePath,
          fileSup
        );
        if (f) findings.push(f);
      }

      // 3. JSX Spread Attributes
      const spreads = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSpreadAttribute);
      for (const spread of spreads) {
        const parentElement = spread.getParent()?.getParent();
        let elementName = 'unknown';
        if (parentElement && (Node.isJsxElement(parentElement) || Node.isJsxSelfClosingElement(parentElement))) {
          const tagNode = Node.isJsxElement(parentElement)
            ? parentElement.getOpeningElement().getTagNameNode()
            : parentElement.getTagNameNode();
          elementName = tagNode.getText();
        }

        const expr = spread.getExpression();
        const resolved = this.resolveExpression(expr);
        if (resolved.type === 'object' && resolved.properties) {
          for (const [propName, propVal] of Object.entries(resolved.properties)) {
            const isKnownComponent = elementName in this.config.checkedComponentProps;
            const isKnownProp = isKnownComponent && this.config.checkedComponentProps[elementName].includes(propName);
            const isCheckedObjKey = this.config.checkedObjectKeys.includes(propName);
            const isIgnoredObjKey = this.config.ignoredObjectKeys.includes(propName);

            if (isIgnoredObjKey) continue;
            if (!isKnownProp && !isCheckedObjKey) continue;

            const kind: FindingKind = 'LocalObjectPropertyUsedInUserFacingContext';
            const confidence: Confidence = isKnownProp ? 'high' : 'medium';
            const reason = isKnownProp
              ? `Object property '${propName}' spread into known component ${elementName}`
              : `Object property '${propName}' spread into component ${elementName}`;

            const f = this.buildFinding(
              propVal.node,
              propVal,
              kind,
              confidence,
              reason,
              { type: 'JSXAttribute', elementName, propName },
              relativePath,
              fileSup
            );
            if (f) findings.push(f);
          }
        }
      }

      // 4. Known Function Arguments
      const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expression = call.getExpression();
        const funcName = expression.getText().replace(/\s+/g, '');

        let argIndices: number[] | null = null;
        if (Array.isArray(this.config.checkedFunctions)) {
          if ((this.config.checkedFunctions as string[]).includes(funcName)) {
            argIndices = [0];
          }
        } else if (this.config.checkedFunctions && typeof this.config.checkedFunctions === 'object') {
          if (funcName in this.config.checkedFunctions) {
            argIndices = (this.config.checkedFunctions as Record<string, number[]>)[funcName];
          }
        }

        if (!argIndices) continue;

        const args = call.getArguments();
        for (const index of argIndices) {
          if (index < args.length) {
            const arg = args[index];
            const resolved = this.resolveExpression(arg);
            if (resolved.type === 'unknown' || resolved.type === 'object') continue;

            const f = this.buildFinding(
              arg,
              resolved,
              'KnownFunctionArgument',
              'high',
              `Argument index ${index} of function call ${funcName}`,
              { type: 'CallExpression', functionName: funcName, argumentIndex: index },
              relativePath,
              fileSup
            );
            if (f) findings.push(f);
          }
        }
      }

      // 5. UI Config Arrays
      const vars = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      for (const variable of vars) {
        const varName = variable.getName();
        const typeNode = variable.getTypeNode();
        const typeName = typeNode ? typeNode.getText() : '';

        const isUiConfigVar = this.config.uiConfigVariables?.includes(varName);
        const isUiConfigType = this.config.uiConfigTypes?.includes(typeName);

        const initializer = variable.getInitializer();
        if (initializer && Node.isArrayLiteralExpression(initializer)) {
          // Check all objects in the array
          for (const element of initializer.getElements()) {
            const resolved = this.resolveExpression(element);
            if (resolved.type === 'object' && resolved.properties) {
              for (const [propName, propVal] of Object.entries(resolved.properties)) {
                const isCheckedObjKey = this.config.checkedObjectKeys.includes(propName);
                const isIgnoredObjKey = this.config.ignoredObjectKeys.includes(propName);

                if (isIgnoredObjKey) continue;
                if (isCheckedObjKey) {
                  const confidence: Confidence = (isUiConfigVar || isUiConfigType) ? 'high' : 'medium';
                  const kind: FindingKind = 'LocalObjectPropertyUsedInUserFacingContext';
                  const reason = `UI configuration object property '${propName}' in array '${varName}'`;

                  const f = this.buildFinding(
                    propVal.node,
                    propVal,
                    kind,
                    confidence,
                    reason,
                    { type: 'VariableDeclaration', variableName: varName, propName },
                    relativePath,
                    fileSup
                  );
                  if (f) findings.push(f);
                }
              }
            }
          }
        }
      }

      // 6. Errors & Exceptions
      if (this.config.scanErrors !== false) {
        const throws = sourceFile.getDescendantsOfKind(SyntaxKind.ThrowStatement);
        for (const thr of throws) {
          const expr = thr.getExpression();
          if (expr && Node.isNewExpression(expr)) {
            const classExpr = expr.getExpression();
            if (classExpr.getText() === 'Error') {
              const args = expr.getArguments();
              if (args.length > 0) {
                const resolved = this.resolveExpression(args[0]);
                if (resolved.type === 'string') {
                  const f = this.buildFinding(
                    args[0],
                    resolved,
                    'ErrorString',
                    'low',
                    'Exception error message',
                    { type: 'ThrowStatement' },
                    relativePath,
                    fileSup
                  );
                  if (f) findings.push(f);
                }
              }
            }
          }
        }
      }
      const fileFindings = findings.slice(startIndex);
      if (cacheManager && stat) {
        cacheManager.setEntry(
          relativePath,
          stat.mtimeMs,
          fileFindings,
          { totalCount: fileSup.totalCount, withoutReasonCount: fileSup.withoutReasonCount }
        );
      }
    }

    if (cacheManager) {
      cacheManager.save();
    }

    // Post-process to group duplicates and format summary
    const summary: ScanSummary = {
      filesScanned: files.length,
      filesWithFindings: 0,
      totalFindings: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      autoFixCandidates: 0,
      needsReview: 0
    };

    const filesWithFindingsSet = new Set<string>();

    // Count findings by confidence and fix candidacy
    for (const f of findings) {
      if (f.confidence !== 'ignored') {
        filesWithFindingsSet.add(f.filePath);
        summary.totalFindings++;
        if (f.confidence === 'high') summary.highConfidence++;
        else if (f.confidence === 'medium') summary.mediumConfidence++;
        else if (f.confidence === 'low') summary.lowConfidence++;

        if (f.autoFixCandidate) summary.autoFixCandidates++;
        if (f.needsReview) summary.needsReview++;
      }
    }
    summary.filesWithFindings = filesWithFindingsSet.size;

    return {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      projectRoot: this.projectRoot,
      summary,
      suppressions: {
        total: suppressionsTotal,
        withoutReason: suppressionsWithoutReason
      },
      findings
    };
  }

  public async getTargetFiles(): Promise<string[]> {
    const excludes = [...this.config.exclude];
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf8');
      const rules = gitignore.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => {
          if (l.endsWith('/')) l = l.slice(0, -1);
          return l.startsWith('/') ? l.slice(1) : `**/${l}`;
        });
      excludes.push(...rules);
    }

    const files = await fg(this.config.include, {
      ignore: excludes,
      absolute: true,
      cwd: this.projectRoot
    });

    return files;
  }
}
