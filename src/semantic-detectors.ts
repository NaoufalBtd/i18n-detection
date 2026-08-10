import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import type { Confidence, FindingKind, ScannerConfig, UserFacingContext } from './types.js';

export interface SemanticCandidate {
  node: Node;
  kind: FindingKind;
  confidence: Confidence;
  reason: string;
  context: UserFacingContext;
}

const VALIDATION_METHODS = new Set([
  'min',
  'max',
  'length',
  'email',
  'url',
  'uuid',
  'regex',
  'refine',
  'superRefine',
  'nonempty'
]);

const METADATA_KEYS = new Set([
  'title',
  'description',
  'applicationName',
  'generator',
  'keywords',
  'authors'
]);

const TECHNICAL_PRESENTATION_VALUES = new Set([
  'default',
  'primary',
  'secondary',
  'success',
  'warning',
  'error',
  'info',
  'neutral',
  'outlined',
  'contained',
  'text',
  'small',
  'medium',
  'large',
  'left',
  'right',
  'center'
]);

function normalizeCallee(value: string): string {
  return value.replace(/\s+/g, '');
}

function propertyName(node: Node): string | undefined {
  if (!Node.isPropertyAssignment(node) && !Node.isShorthandPropertyAssignment(node)) return undefined;
  return node.getName();
}

function literalValue(node: Node): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return undefined;
}

function isLikelyNaturalLanguage(value: string): boolean {
  const text = value.trim();
  if (text.length < 2) return false;
  if (TECHNICAL_PRESENTATION_VALUES.has(text)) return false;
  if (/^[A-Z0-9_./:-]+$/.test(text)) return false;
  return /\p{L}/u.test(text) && (/[a-z\u00c0-\u024f\u0600-\u06ff]/u.test(text) || /\s/.test(text));
}

function stringBearingExpression(node: Node): boolean {
  const direct = literalValue(node);
  if (direct !== undefined) return isLikelyNaturalLanguage(direct);
  if (Node.isTemplateExpression(node)) {
    const text = `${node.getHead().getLiteralText()} ${node.getTemplateSpans().map(span => span.getLiteral().getLiteralText()).join(' ')}`;
    return isLikelyNaturalLanguage(text);
  }
  if (Node.isConditionalExpression(node) || Node.isBinaryExpression(node)) {
    return node
      .getDescendantsOfKind(SyntaxKind.StringLiteral)
      .some(stringNode => isLikelyNaturalLanguage(stringNode.getLiteralValue()));
  }
  return false;
}

function containingFunctionName(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isFunctionDeclaration(current)) return current.getName();
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      const parent = current.getParent();
      if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
      if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
    }
    if (Node.isMethodDeclaration(current)) return current.getName();
    current = current.getParent();
  }
  return undefined;
}

function containingVariableName(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isVariableDeclaration(current)) return current.getName();
    current = current.getParent();
  }
  return undefined;
}

function isInsideJsxExpression(node: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (Node.isJsxExpression(current)) return true;
    if (Node.isFunctionDeclaration(current) || Node.isArrowFunction(current) || Node.isFunctionExpression(current)) return false;
    current = current.getParent();
  }
  return false;
}

function isTranslationApiCall(call: Node, config: ScannerConfig): boolean {
  if (!Node.isCallExpression(call)) return false;
  const callee = normalizeCallee(call.getExpression().getText());
  return Boolean(config.semantic?.translationApis.some(rule => normalizeCallee(rule.callee) === callee));
}

function addCandidate(
  target: SemanticCandidate[],
  seen: Set<string>,
  candidate: SemanticCandidate
): void {
  const key = `${candidate.node.getStart()}:${candidate.kind}:${candidate.context.type}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(candidate);
}

function detectTranslationSources(
  sourceFile: SourceFile,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic) return;

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = normalizeCallee(call.getExpression().getText());
    for (const rule of semantic.translationApis) {
      if (normalizeCallee(rule.callee) !== callee) continue;
      const args = call.getArguments();

      if (rule.fallbackArgument !== undefined) {
        const fallback = args[rule.fallbackArgument];
        if (fallback && literalValue(fallback) !== undefined && isLikelyNaturalLanguage(literalValue(fallback)!)) {
          addCandidate(candidates, seen, {
            node: fallback,
            kind: 'TranslationFallback',
            confidence: 'low',
            reason: `Translation call '${callee}' contains source fallback copy`,
            context: { type: 'TranslationFallback', functionName: callee, argumentIndex: rule.fallbackArgument }
          });
        }
      }

      if (rule.optionsArgument !== undefined && rule.defaultValueProperty) {
        const options = args[rule.optionsArgument];
        if (options && Node.isObjectLiteralExpression(options)) {
          const property = options.getProperty(rule.defaultValueProperty);
          if (property && Node.isPropertyAssignment(property)) {
            const initializer = property.getInitializer();
            if (initializer && stringBearingExpression(initializer)) {
              addCandidate(candidates, seen, {
                node: initializer,
                kind: 'TranslationDefaultValue',
                confidence: 'low',
                reason: `Translation call '${callee}' contains default source copy`,
                context: {
                  type: 'TranslationDefaultValue',
                  functionName: callee,
                  argumentIndex: rule.optionsArgument,
                  propName: rule.defaultValueProperty
                }
              });
            }
          }
        }
      }
    }
  }

  for (const template of sourceFile.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    const hasTranslationExpression = template
      .getTemplateSpans()
      .some(span => {
        const expression = span.getExpression();
        return Node.isCallExpression(expression) && isTranslationApiCall(expression, config);
      });
    if (!hasTranslationExpression) continue;
    const literalText = `${template.getHead().getLiteralText()} ${template
      .getTemplateSpans()
      .map(span => span.getLiteral().getLiteralText())
      .join(' ')}`;
    if (!isLikelyNaturalLanguage(literalText)) continue;
    addCandidate(candidates, seen, {
      node: template,
      kind: 'TemplateLiteralUsedInUserFacingContext',
      confidence: 'medium',
      reason: 'Template literal mixes translated output with hardcoded literal fragments',
      context: { type: 'TranslatedLiteralFragment' }
    });
  }
}

function detectPresentationObjects(
  sourceFile: SourceFile,
  relativeFilePath: string,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic) return;
  const lowerPath = relativeFilePath.toLowerCase();
  const fileMatches = semantic.presentationFilePatterns.some(pattern => lowerPath.includes(pattern.toLowerCase()));
  const functionPatterns = semantic.presentationFunctionPatterns.map(pattern => new RegExp(pattern, 'i'));
  const broadVariables = new Set(semantic.translationObjectVariables);
  const semanticKeys = new Set(semantic.presentationObjectKeys);

  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = propertyName(property);
    const initializer = property.getInitializer();
    if (!name || !initializer || !stringBearingExpression(initializer)) continue;
    if (name === 'defaultValue') continue;

    const functionName = containingFunctionName(property);
    const variableName = containingVariableName(property);
    const functionMatches = Boolean(functionName && functionPatterns.some(pattern => pattern.test(functionName)));
    const broadVariable = Boolean(variableName && broadVariables.has(variableName));
    const translationSource = /translations?/i.test(relativeFilePath) || Boolean(functionName && /^use.*Translations$/i.test(functionName));
    const broadContext = translationSource || broadVariable || Boolean(functionName && /^get.*Columns$/i.test(functionName));

    if (!broadContext && !fileMatches && !functionMatches) continue;
    if (!broadContext && !semanticKeys.has(name)) continue;

    addCandidate(candidates, seen, {
      node: initializer,
      kind: 'PresentationObjectString',
      confidence: translationSource || broadVariable ? 'high' : 'medium',
      reason: translationSource
        ? 'Hardcoded copy stored in a translation/presentation object'
        : `Presentation object property '${name}' contains user-facing source copy`,
      context: {
        type: 'PresentationObject',
        functionName,
        variableName,
        propName: name
      }
    });
  }
}

function detectInlineLocaleMaps(
  sourceFile: SourceFile,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic || semantic.inlineLocaleKeys.length < 2) return;
  const localeKeys = new Set(semantic.inlineLocaleKeys);

  for (const variable of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) continue;
    const localeProperties = initializer
      .getProperties()
      .filter(Node.isPropertyAssignment)
      .filter(property => localeKeys.has(property.getName()))
      .filter(property => Node.isObjectLiteralExpression(property.getInitializer()));
    if (localeProperties.length < 2) continue;

    for (const localeProperty of localeProperties) {
      const locale = localeProperty.getName();
      const localeObject = localeProperty.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
      if (!localeObject) continue;
      for (const property of localeObject.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        const value = property.getInitializer();
        if (!value || literalValue(value) === undefined || !isLikelyNaturalLanguage(literalValue(value)!)) continue;
        addCandidate(candidates, seen, {
          node: value,
          kind: 'InlineLocaleCatalogString',
          confidence: 'medium',
          reason: `Inline locale map '${variable.getName()}' contains '${locale}' source copy outside the configured catalog system`,
          context: {
            type: 'InlineLocaleCatalog',
            variableName: variable.getName(),
            propName: property.getName()
          }
        });
      }
    }
  }
}

function detectValidationMessages(
  sourceFile: SourceFile,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  if (!config.semantic?.scanValidationMessages) return;

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const method = expression.getName();
    if (!VALIDATION_METHODS.has(method)) continue;

    for (const [index, argument] of call.getArguments().entries()) {
      const direct = literalValue(argument);
      if (direct !== undefined && isLikelyNaturalLanguage(direct)) {
        addCandidate(candidates, seen, {
          node: argument,
          kind: 'ValidationMessage',
          confidence: 'medium',
          reason: `Validation method '.${method}()' contains a human-readable message`,
          context: { type: 'ValidationMessage', functionName: method, argumentIndex: index }
        });
        continue;
      }
      if (!Node.isObjectLiteralExpression(argument)) continue;
      const message = argument.getProperty('message');
      if (!message || !Node.isPropertyAssignment(message)) continue;
      const initializer = message.getInitializer();
      if (!initializer || literalValue(initializer) === undefined || !isLikelyNaturalLanguage(literalValue(initializer)!)) continue;
      addCandidate(candidates, seen, {
        node: initializer,
        kind: 'ValidationMessage',
        confidence: 'medium',
        reason: `Validation method '.${method}()' contains a human-readable message`,
        context: { type: 'ValidationMessage', functionName: method, argumentIndex: index, propName: 'message' }
      });
    }
  }
}

function detectStateMessages(
  sourceFile: SourceFile,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  for (const variable of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = variable.getNameNode();
    const initializer = variable.getInitializer();
    if (!Node.isArrayBindingPattern(nameNode) || !initializer || !Node.isCallExpression(initializer)) continue;
    if (normalizeCallee(initializer.getExpression().getText()) !== 'useState') continue;

    const elements = nameNode.getElements();
    if (elements.length < 2) continue;
    const stateName = elements[0]?.getNameNode().getText();
    const setterName = elements[1]?.getNameNode().getText();
    if (!stateName || !setterName) continue;

    const rendered = sourceFile
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .some(identifier => identifier.getText() === stateName && isInsideJsxExpression(identifier));
    if (!rendered) continue;

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (normalizeCallee(call.getExpression().getText()) !== setterName) continue;
      const argument = call.getArguments()[0];
      if (!argument || !stringBearingExpression(argument)) continue;
      addCandidate(candidates, seen, {
        node: argument,
        kind: 'KnownFunctionArgument',
        confidence: 'medium',
        reason: `State setter '${setterName}' stores hardcoded copy that is rendered through '${stateName}'`,
        context: {
          type: 'StateMessage',
          functionName: setterName,
          argumentIndex: 0,
          variableName: stateName
        }
      });
    }
  }
}

function insideMetadataContext(node: Node): boolean {
  const functionName = containingFunctionName(node);
  if (functionName === 'generateMetadata') return true;
  const variableName = containingVariableName(node);
  return variableName === 'metadata';
}

function detectNextMetadata(
  sourceFile: SourceFile,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  if (!config.semantic?.scanNextMetadata) return;

  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = propertyName(property);
    const initializer = property.getInitializer();
    if (!name || !METADATA_KEYS.has(name) || !initializer || !insideMetadataContext(property)) continue;
    if (!stringBearingExpression(initializer)) continue;
    addCandidate(candidates, seen, {
      node: initializer,
      kind: 'NextMetadataString',
      confidence: 'medium',
      reason: `Next.js metadata property '${name}' contains hardcoded source copy`,
      context: { type: 'NextMetadata', functionName: containingFunctionName(property), propName: name }
    });
  }
}

export function detectSemanticCandidates(
  sourceFile: SourceFile,
  relativeFilePath: string,
  config: ScannerConfig
): SemanticCandidate[] {
  const candidates: SemanticCandidate[] = [];
  const seen = new Set<string>();
  detectTranslationSources(sourceFile, config, candidates, seen);
  detectPresentationObjects(sourceFile, relativeFilePath, config, candidates, seen);
  detectInlineLocaleMaps(sourceFile, config, candidates, seen);
  detectValidationMessages(sourceFile, config, candidates, seen);
  detectStateMessages(sourceFile, candidates, seen);
  detectNextMetadata(sourceFile, config, candidates, seen);
  return candidates.sort((a, b) => a.node.getStart() - b.node.getStart() || a.kind.localeCompare(b.kind));
}
