import {
  Node,
  SyntaxKind,
  type CallExpression,
  type Identifier,
  type PropertyAssignment,
  type SourceFile,
  type TemplateExpression,
  type VariableDeclaration
} from 'ts-morph';
import { asArrayLiteral, asObjectLiteral, unwrapExpression } from './ast-utils.js';
import type {
  Confidence,
  FindingKind,
  ScannerConfig,
  UserFacingContext
} from './types.js';

export interface SemanticCandidate {
  node: Node;
  kind: FindingKind;
  confidence: Confidence;
  reason: string;
  context: UserFacingContext;
  rule?: string;
  translationNamespace?: string;
  referencedTranslationKey?: string;
  resolvedTranslationKey?: string;
  fallbackValue?: string;
}

interface SemanticIndex {
  calls: CallExpression[];
  properties: PropertyAssignment[];
  variables: VariableDeclaration[];
  templates: TemplateExpression[];
  identifiers: Identifier[];
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
  'nonempty',
  'custom'
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
  'center',
  'grid',
  'list',
  'auto',
  'active',
  'inactive'
]);

function buildIndex(sourceFile: SourceFile): SemanticIndex {
  const index: SemanticIndex = {
    calls: [],
    properties: [],
    variables: [],
    templates: [],
    identifiers: []
  };

  sourceFile.forEachDescendant(node => {
    if (Node.isCallExpression(node)) index.calls.push(node);
    else if (Node.isPropertyAssignment(node)) index.properties.push(node);
    else if (Node.isVariableDeclaration(node)) index.variables.push(node);
    else if (Node.isTemplateExpression(node)) index.templates.push(node);
    else if (Node.isIdentifier(node)) index.identifiers.push(node);
  });

  return index;
}

function normalizeCallee(value: string): string {
  return value.replace(/\s+/g, '');
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function pathMatches(relativeFilePath: string, include: string[]): boolean {
  if (include.length === 0) return true;
  const file = normalizedPath(relativeFilePath);
  return include.some(pattern => {
    const normalized = normalizedPath(pattern);
    const directory = normalized.endsWith('/') ? normalized : `${normalized}/`;
    return file === normalized.replace(/\/$/, '') || file.startsWith(directory);
  });
}

function propertyName(node: Node): string | undefined {
  if (!Node.isPropertyAssignment(node) && !Node.isShorthandPropertyAssignment(node)) return undefined;
  return node.getName();
}

function literalValue(node: Node): string | undefined {
  const value = unwrapExpression(node);
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) return value.getLiteralValue();
  return undefined;
}

function isLikelyNaturalLanguage(value: string): boolean {
  const text = value.trim();
  if (text.length < 2) return false;
  if (TECHNICAL_PRESENTATION_VALUES.has(text.toLowerCase())) return false;
  if (/^[A-Z0-9_./:-]+$/.test(text)) return false;
  return /\p{L}/u.test(text) && (/[a-z\u00c0-\u024f\u0600-\u06ff]/u.test(text) || /\s/.test(text));
}

function stringBearingExpression(node: Node): boolean {
  const value = unwrapExpression(node);
  const direct = literalValue(value);
  if (direct !== undefined) return isLikelyNaturalLanguage(direct);
  if (Node.isTemplateExpression(value)) {
    const text = `${value.getHead().getLiteralText()} ${value.getTemplateSpans().map(span => span.getLiteral().getLiteralText()).join(' ')}`;
    return isLikelyNaturalLanguage(text);
  }
  if (Node.isConditionalExpression(value) || Node.isBinaryExpression(value)) {
    return value
      .getDescendantsOfKind(SyntaxKind.StringLiteral)
      .some(stringNode => isLikelyNaturalLanguage(stringNode.getLiteralValue()));
  }
  return false;
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
  let current: Node | undefined = node.getParent();
  while (current) {
    if (isFunctionScope(current)) return current;
    current = current.getParent();
  }
  return undefined;
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

function isInsideJsxExpression(node: Node, owningScope: Node | undefined): boolean {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (Node.isJsxExpression(current)) return true;
    if (current === owningScope) return false;
    current = current.getParent();
  }
  return false;
}

function sameScope(node: Node, scope: Node | undefined): boolean {
  if (!scope) return nearestFunctionScope(node) === undefined;
  let current: Node | undefined = node;
  while (current) {
    if (current === scope) return true;
    current = current.getParent();
  }
  return false;
}

function definitionMatches(identifier: Identifier, binding: Node): boolean {
  const definitions = identifier.getDefinitionNodes();
  if (definitions.length === 0) return true;
  const bindingStart = binding.getStart();
  return definitions.some(definition => {
    if (definition === binding || definition.getStart() === bindingStart) return true;
    const owner = definition.getFirstAncestor(ancestor => ancestor.getStart() === bindingStart);
    return Boolean(owner);
  });
}

function translationNamespaceFromCall(call: CallExpression, config: ScannerConfig): string | undefined {
  const callee = normalizeCallee(call.getExpression().getText());
  if (callee === config.i18n.clientHook || callee === config.i18n.serverAsyncFunction) {
    const first = call.getArguments()[0];
    return first && literalValue(first) !== undefined ? literalValue(first) : undefined;
  }
  return config.semantic?.translationHooks[callee];
}

function namespaceFromBinding(call: CallExpression, config: ScannerConfig): string | undefined {
  const expression = call.getExpression();
  const identifier = Node.isIdentifier(expression)
    ? expression
    : Node.isPropertyAccessExpression(expression) && Node.isIdentifier(expression.getExpression())
      ? expression.getExpression()
      : undefined;
  if (!identifier) return undefined;

  for (const definition of identifier.getDefinitionNodes()) {
    const declaration = Node.isVariableDeclaration(definition)
      ? definition
      : definition.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const initializer = declaration?.getInitializer();
    if (!initializer) continue;
    const unwrapped = unwrapExpression(initializer);
    if (Node.isCallExpression(unwrapped)) {
      const namespace = translationNamespaceFromCall(unwrapped, config);
      if (namespace) return namespace;
    }
  }
  return undefined;
}

function inferTranslationNamespace(
  call: CallExpression,
  config: ScannerConfig,
  index: SemanticIndex
): string | undefined {
  const bindingNamespace = namespaceFromBinding(call, config);
  if (bindingNamespace) return bindingNamespace;

  const scopes: (Node | undefined)[] = [nearestFunctionScope(call), undefined];
  for (const scope of scopes) {
    const namespaces = new Set<string>();
    for (const candidate of index.calls) {
      if (nearestFunctionScope(candidate) !== scope) continue;
      const namespace = translationNamespaceFromCall(candidate, config);
      if (namespace) namespaces.add(namespace);
    }
    if (namespaces.size === 1) return [...namespaces][0];
    if (namespaces.size > 1) return undefined;
  }
  return undefined;
}

function resolveTranslationKey(key: string | undefined, namespace: string | undefined): string | undefined {
  if (!key) return undefined;
  if (!namespace) return key;
  if (key === namespace || key.startsWith(`${namespace}.`)) return key;
  return `${namespace}.${key}`;
}

function isTranslationApiCall(call: Node, config: ScannerConfig): boolean {
  if (!Node.isCallExpression(call)) return false;
  const callee = normalizeCallee(call.getExpression().getText());
  return Boolean(config.semantic?.translationApis.some(rule => normalizeCallee(rule.callee) === callee));
}

function addCandidate(target: SemanticCandidate[], seen: Set<string>, candidate: SemanticCandidate): void {
  const key = `${candidate.node.getStart()}:${candidate.kind}:${candidate.context.type}:${candidate.rule ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(candidate);
}

function detectTranslationSources(
  index: SemanticIndex,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic) return;

  for (const call of index.calls) {
    const callee = normalizeCallee(call.getExpression().getText());
    for (const rule of semantic.translationApis) {
      if (normalizeCallee(rule.callee) !== callee) continue;
      const args = call.getArguments();
      const keyArgument = rule.keyArgument ?? 0;
      const referencedTranslationKey = args[keyArgument] ? literalValue(args[keyArgument]) : undefined;
      const translationNamespace = inferTranslationNamespace(call, config, index);
      const resolvedTranslationKey = resolveTranslationKey(referencedTranslationKey, translationNamespace);

      if (rule.fallbackArgument !== undefined) {
        const fallback = args[rule.fallbackArgument];
        const fallbackValue = fallback ? literalValue(fallback) : undefined;
        if (fallback && fallbackValue !== undefined && isLikelyNaturalLanguage(fallbackValue)) {
          addCandidate(candidates, seen, {
            node: fallback,
            kind: 'TranslationFallback',
            confidence: 'low',
            reason: `Translation call '${callee}' contains source fallback copy`,
            rule: 'i18n/translation-fallback',
            context: { type: 'TranslationFallback', functionName: callee, argumentIndex: rule.fallbackArgument },
            translationNamespace,
            referencedTranslationKey,
            resolvedTranslationKey,
            fallbackValue
          });
        }
      }

      if (rule.optionsArgument !== undefined && rule.defaultValueProperty) {
        const options = asObjectLiteral(args[rule.optionsArgument]);
        const property = options?.getProperty(rule.defaultValueProperty);
        if (property && Node.isPropertyAssignment(property)) {
          const initializer = property.getInitializer();
          const fallbackValue = initializer ? literalValue(initializer) : undefined;
          if (initializer && stringBearingExpression(initializer)) {
            addCandidate(candidates, seen, {
              node: initializer,
              kind: 'TranslationDefaultValue',
              confidence: 'low',
              reason: `Translation call '${callee}' contains default source copy`,
              rule: 'i18n/translation-default-value',
              context: {
                type: 'TranslationDefaultValue',
                functionName: callee,
                argumentIndex: rule.optionsArgument,
                propName: rule.defaultValueProperty
              },
              translationNamespace,
              referencedTranslationKey,
              resolvedTranslationKey,
              fallbackValue
            });
          }
        }
      }
    }
  }

  for (const template of index.templates) {
    const hasTranslationExpression = template.getTemplateSpans().some(span => {
      const expression = unwrapExpression(span.getExpression());
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
      rule: 'i18n/translated-literal-fragment',
      context: { type: 'TranslatedLiteralFragment' }
    });
  }
}

function detectPresentationObjects(
  index: SemanticIndex,
  relativeFilePath: string,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic || !pathMatches(relativeFilePath, semantic.presentationInclude)) return;
  const lowerPath = relativeFilePath.toLowerCase();
  const fileMatches = semantic.presentationFilePatterns.some(pattern => lowerPath.includes(pattern.toLowerCase()));
  const functionPatterns = semantic.presentationFunctionPatterns.map(pattern => new RegExp(pattern, 'i'));
  const broadVariables = new Set(semantic.translationObjectVariables);
  const semanticKeys = new Set(semantic.presentationObjectKeys);

  for (const property of index.properties) {
    const name = propertyName(property);
    const initializer = property.getInitializer();
    if (!name || !initializer || !stringBearingExpression(initializer) || name === 'defaultValue') continue;

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
      rule: 'i18n/presentation-object',
      context: {
        type: 'PresentationObject',
        functionName,
        variableName,
        propName: name
      }
    });
  }
}

function visitSemanticRegistryValues(
  node: Node,
  semanticKeys: Set<string>,
  callback: (value: Node, property: string) => void
): void {
  const value = unwrapExpression(node);
  const object = asObjectLiteral(value);
  if (object) {
    for (const property of object.getProperties()) {
      if (!Node.isPropertyAssignment(property)) continue;
      const name = property.getName();
      const initializer = property.getInitializer();
      if (!initializer) continue;
      if (semanticKeys.has(name) && stringBearingExpression(initializer)) callback(initializer, name);
      const child = unwrapExpression(initializer);
      if (asObjectLiteral(child) || asArrayLiteral(child)) visitSemanticRegistryValues(child, semanticKeys, callback);
    }
    return;
  }

  const array = asArrayLiteral(value);
  if (array) {
    for (const element of array.getElements()) visitSemanticRegistryValues(element, semanticKeys, callback);
  }
}

function detectStaticUiRegistries(
  index: SemanticIndex,
  relativeFilePath: string,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic || !pathMatches(relativeFilePath, semantic.staticRegistryInclude)) return;
  const patterns = semantic.staticRegistryVariablePatterns.map(pattern => new RegExp(pattern, 'i'));
  const semanticKeys = new Set(semantic.staticRegistryObjectKeys);

  for (const variable of index.variables) {
    const variableName = variable.getName();
    if (!patterns.some(pattern => pattern.test(variableName))) continue;
    const initializer = variable.getInitializer();
    if (!initializer) continue;
    const root = unwrapExpression(initializer);
    if (!asObjectLiteral(root) && !asArrayLiteral(root)) continue;

    visitSemanticRegistryValues(root, semanticKeys, (value, propName) => {
      addCandidate(candidates, seen, {
        node: value,
        kind: 'StaticUiRegistryString',
        confidence: 'medium',
        reason: `Static UI registry '${variableName}' contains user-facing property '${propName}'`,
        rule: 'i18n/static-ui-registry',
        context: { type: 'StaticUiRegistry', variableName, propName }
      });
    });
  }
}

function detectInlineLocaleMaps(
  index: SemanticIndex,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic || semantic.inlineLocaleKeys.length < 2) return;
  const localeKeys = new Set(semantic.inlineLocaleKeys);

  for (const variable of index.variables) {
    const initializer = asObjectLiteral(variable.getInitializer());
    if (!initializer) continue;
    const localeProperties = initializer
      .getProperties()
      .filter(Node.isPropertyAssignment)
      .filter(property => localeKeys.has(property.getName()))
      .filter(property => Boolean(asObjectLiteral(property.getInitializer())));
    if (localeProperties.length < 2) continue;

    for (const localeProperty of localeProperties) {
      const locale = localeProperty.getName();
      const localeObject = asObjectLiteral(localeProperty.getInitializer());
      if (!localeObject) continue;
      for (const property of localeObject.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        const value = property.getInitializer();
        const text = value ? literalValue(value) : undefined;
        if (!value || text === undefined || !isLikelyNaturalLanguage(text)) continue;
        addCandidate(candidates, seen, {
          node: value,
          kind: 'InlineLocaleCatalogString',
          confidence: 'medium',
          reason: `Inline locale map '${variable.getName()}' contains '${locale}' source copy outside the configured catalog system`,
          rule: 'i18n/inline-locale-catalog',
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

function hasZodImport(sourceFile: SourceFile): boolean {
  return sourceFile.getImportDeclarations().some(declaration => declaration.getModuleSpecifierValue() === 'zod');
}

function likelyZodCall(call: CallExpression): boolean {
  const expressionText = call.getExpression().getText();
  const fullText = call.getText();
  if (/\bz\./.test(fullText)) return true;
  if (/Schema\b/.test(expressionText)) return true;
  const variableName = containingVariableName(call);
  return Boolean(variableName && /Schema$/.test(variableName));
}

function detectValidationMessages(
  sourceFile: SourceFile,
  index: SemanticIndex,
  relativeFilePath: string,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic?.scanValidationMessages || !pathMatches(relativeFilePath, semantic.validationInclude) || !hasZodImport(sourceFile)) return;

  for (const call of index.calls) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const method = expression.getName();
    if (!VALIDATION_METHODS.has(method) || !likelyZodCall(call)) continue;

    for (const [argumentIndex, argument] of call.getArguments().entries()) {
      const direct = literalValue(argument);
      if (direct !== undefined && isLikelyNaturalLanguage(direct)) {
        addCandidate(candidates, seen, {
          node: argument,
          kind: 'ValidationMessage',
          confidence: 'medium',
          reason: `Zod validation method '.${method}()' contains a human-readable message`,
          rule: 'i18n/validation-message',
          context: { type: 'ValidationMessage', functionName: method, argumentIndex }
        });
        continue;
      }

      const options = asObjectLiteral(argument);
      if (!options) continue;
      for (const propName of ['message', 'required_error', 'invalid_type_error']) {
        const message = options.getProperty(propName);
        if (!message || !Node.isPropertyAssignment(message)) continue;
        const initializer = message.getInitializer();
        const text = initializer ? literalValue(initializer) : undefined;
        if (!initializer || text === undefined || !isLikelyNaturalLanguage(text)) continue;
        addCandidate(candidates, seen, {
          node: initializer,
          kind: 'ValidationMessage',
          confidence: 'medium',
          reason: `Zod validation method '.${method}()' contains a human-readable ${propName} message`,
          rule: 'i18n/validation-message',
          context: { type: 'ValidationMessage', functionName: method, argumentIndex, propName }
        });
      }
    }
  }

  for (const call of index.calls) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'addIssue') continue;
    const issue = asObjectLiteral(call.getArguments()[0]);
    const message = issue?.getProperty('message');
    if (!message || !Node.isPropertyAssignment(message)) continue;
    const initializer = message.getInitializer();
    const text = initializer ? literalValue(initializer) : undefined;
    if (!initializer || text === undefined || !isLikelyNaturalLanguage(text)) continue;
    addCandidate(candidates, seen, {
      node: initializer,
      kind: 'ValidationMessage',
      confidence: 'medium',
      reason: 'Zod issue contains a human-readable validation message',
      rule: 'i18n/validation-message',
      context: { type: 'ValidationMessage', functionName: 'addIssue', propName: 'message' }
    });
  }
}

function owningPropertyName(node: Node): string | undefined {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (Node.isPropertyAssignment(current)) return current.getName();
    if (isFunctionScope(current)) return undefined;
    current = current.getParent();
  }
  return undefined;
}

function detectSchemaDefaults(
  sourceFile: SourceFile,
  index: SemanticIndex,
  relativeFilePath: string,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  const semantic = config.semantic;
  if (!semantic?.scanSchemaDefaults || !pathMatches(relativeFilePath, semantic.validationInclude) || !hasZodImport(sourceFile)) return;
  const semanticKeys = new Set(semantic.schemaDefaultKeys);

  for (const call of index.calls) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'default' || !likelyZodCall(call)) continue;
    const argument = call.getArguments()[0];
    if (!argument) continue;

    const owner = owningPropertyName(call);
    const direct = literalValue(argument);
    if (owner && semanticKeys.has(owner) && direct !== undefined && isLikelyNaturalLanguage(direct)) {
      addCandidate(candidates, seen, {
        node: argument,
        kind: 'SchemaDefaultString',
        confidence: 'medium',
        reason: `Zod schema default for user-facing field '${owner}' contains source copy`,
        rule: 'i18n/schema-default',
        context: { type: 'SchemaDefault', propName: owner }
      });
    }

    const nested = unwrapExpression(argument);
    if (asObjectLiteral(nested) || asArrayLiteral(nested)) {
      visitSemanticRegistryValues(nested, semanticKeys, (value, propName) => {
        addCandidate(candidates, seen, {
          node: value,
          kind: 'SchemaDefaultString',
          confidence: 'medium',
          reason: `Zod schema default contains user-facing property '${propName}'`,
          rule: 'i18n/schema-default',
          context: { type: 'SchemaDefault', propName }
        });
      });
    }
  }
}

function detectStateMessages(index: SemanticIndex, candidates: SemanticCandidate[], seen: Set<string>): void {
  for (const variable of index.variables) {
    const nameNode = variable.getNameNode();
    const initializer = variable.getInitializer();
    const unwrapped = initializer ? unwrapExpression(initializer) : undefined;
    if (!Node.isArrayBindingPattern(nameNode) || !unwrapped || !Node.isCallExpression(unwrapped)) continue;
    if (normalizeCallee(unwrapped.getExpression().getText()) !== 'useState') continue;

    const elements = nameNode.getElements();
    if (elements.length < 2) continue;
    const stateElement = elements[0];
    const setterElement = elements[1];
    if (!stateElement || !setterElement || !Node.isBindingElement(stateElement) || !Node.isBindingElement(setterElement)) continue;
    const stateNameNode = stateElement.getNameNode();
    const setterNameNode = setterElement.getNameNode();
    if (!Node.isIdentifier(stateNameNode) || !Node.isIdentifier(setterNameNode)) continue;
    const stateName = stateNameNode.getText();
    const setterName = setterNameNode.getText();
    const scope = nearestFunctionScope(variable);

    const rendered = index.identifiers.some(identifier =>
      identifier.getText() === stateName &&
      sameScope(identifier, scope) &&
      definitionMatches(identifier, stateElement) &&
      isInsideJsxExpression(identifier, scope)
    );
    if (!rendered) continue;

    for (const call of index.calls) {
      if (!sameScope(call, scope)) continue;
      const expression = call.getExpression();
      if (!Node.isIdentifier(expression) || expression.getText() !== setterName) continue;
      if (!definitionMatches(expression, setterElement)) continue;
      const argument = call.getArguments()[0];
      if (!argument || !stringBearingExpression(argument)) continue;
      addCandidate(candidates, seen, {
        node: argument,
        kind: 'StateMessage',
        confidence: 'medium',
        reason: `State setter '${setterName}' stores hardcoded copy that is rendered through '${stateName}'`,
        rule: 'i18n/state-message',
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
  index: SemanticIndex,
  config: ScannerConfig,
  candidates: SemanticCandidate[],
  seen: Set<string>
): void {
  if (!config.semantic?.scanNextMetadata) return;

  for (const property of index.properties) {
    const name = propertyName(property);
    const initializer = property.getInitializer();
    if (!name || !METADATA_KEYS.has(name) || !initializer || !insideMetadataContext(property)) continue;
    if (!stringBearingExpression(initializer)) continue;
    addCandidate(candidates, seen, {
      node: initializer,
      kind: 'NextMetadataString',
      confidence: 'medium',
      reason: `Next.js metadata property '${name}' contains hardcoded source copy`,
      rule: 'i18n/next-metadata',
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
  const index = buildIndex(sourceFile);

  detectTranslationSources(index, config, candidates, seen);
  detectPresentationObjects(index, relativeFilePath, config, candidates, seen);
  detectStaticUiRegistries(index, relativeFilePath, config, candidates, seen);
  detectInlineLocaleMaps(index, config, candidates, seen);
  detectValidationMessages(sourceFile, index, relativeFilePath, config, candidates, seen);
  detectSchemaDefaults(sourceFile, index, relativeFilePath, config, candidates, seen);
  detectStateMessages(index, candidates, seen);
  detectNextMetadata(index, config, candidates, seen);

  return candidates.sort((a, b) => a.node.getStart() - b.node.getStart() || a.kind.localeCompare(b.kind));
}
