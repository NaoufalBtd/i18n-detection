import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Project,
  SyntaxKind,
  Node,
  type Block,
  type Diagnostic,
  type SourceFile,
  ts
} from 'ts-morph';
import type { Finding, ScannerConfig, Confidence } from './types.js';
import { writeFilesAtomically } from './io.js';

export interface CodemodResult {
  filePath: string;
  success: boolean;
  modified: boolean;
  error?: string;
  blocked: { findingId: string; reason: string }[];
  patches: { line: number; original: string; modified: string }[];
  plannedContent?: string;
}

export interface CodemodOptions {
  dryRun: boolean;
  confidence: Exclude<Confidence, 'ignored'>;
  findingId?: string;
  keyOverrides?: Record<string, string>;
}

interface TranslationBinding {
  type: 'known' | 'unknown' | 'missing';
  namespace?: string;
}

interface ComponentTarget {
  block: Block;
  async: boolean;
  name: string;
}

interface PlannedInjection {
  block: Block;
  async: boolean;
}

function findNodeAtLineAndColumn(sourceFile: SourceFile, line: number, column: number): Node | undefined {
  const matches = sourceFile.getDescendants().filter(descendant => {
    const location = sourceFile.getLineAndColumnAtPos(descendant.getStart());
    return location.line === line && location.column === column;
  });
  matches.sort((a, b) => a.getWidth() - b.getWidth());
  return matches[0];
}

function isAncestor(ancestor: Node, node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.getParent();
  }
  return false;
}

function declarationScope(node: Node): Node | undefined {
  let current = node.getParent();
  while (current) {
    if (
      Node.isForStatement(current) ||
      Node.isForInStatement(current) ||
      Node.isForOfStatement(current) ||
      Node.isCatchClause(current)
    ) {
      return current;
    }
    if (Node.isBlock(current) || Node.isSourceFile(current)) return current;
    current = current.getParent();
  }
  return undefined;
}

function unwrapCall(node: Node | undefined): Node | undefined {
  if (!node) return undefined;
  if (Node.isAwaitExpression(node)) return node.getExpression();
  return node;
}

function findVisibleTranslationBinding(node: Node, config: ScannerConfig): TranslationBinding {
  const tName = config.i18n.translationFunctionName;
  const candidates = node
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter(declaration => declaration.getName() === tName && declaration.getStart() < node.getStart())
    .filter(declaration => {
      const scope = declarationScope(declaration);
      return Boolean(scope && isAncestor(scope, node));
    })
    .sort((a, b) => b.getStart() - a.getStart());

  const declaration = candidates[0];
  if (!declaration) return { type: 'missing' };

  const initializer = unwrapCall(declaration.getInitializer());
  if (!initializer || !Node.isCallExpression(initializer)) return { type: 'unknown' };
  const callName = initializer.getExpression().getText();
  if (callName !== config.i18n.clientHook && callName !== config.i18n.serverAsyncFunction) {
    return { type: 'unknown' };
  }

  const args = initializer.getArguments();
  if (args.length === 0) return { type: 'known' };
  if (args.length === 1 && Node.isStringLiteral(args[0])) {
    return { type: 'known', namespace: args[0].getLiteralValue() };
  }
  return { type: 'unknown' };
}

function componentNameForFunction(node: Node): string | undefined {
  if (Node.isFunctionDeclaration(node)) return node.getName();
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  }
  return undefined;
}

function findEnclosingComponent(node: Node): ComponentTarget | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isFunctionDeclaration(current) || Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      const name = componentNameForFunction(current);
      if (name && /^[A-Z]/.test(name)) {
        const body = current.getBody();
        if (body && Node.isBlock(body)) {
          return { block: body, async: current.isAsync(), name };
        }
      }
    }
    current = current.getParent();
  }
  return undefined;
}

function bindingTextContainsName(bindingText: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zA-Z0-9_$])${escaped}([^a-zA-Z0-9_$]|$)`).test(bindingText);
}

function scopeHasOwnTranslationName(block: Block, tName: string): boolean {
  const variableBinding = block
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .some(declaration => bindingTextContainsName(declaration.getName(), tName) && declarationScope(declaration) === block);
  if (variableBinding) return true;

  const owner = block.getParent();
  if (owner && (Node.isFunctionDeclaration(owner) || Node.isArrowFunction(owner) || Node.isFunctionExpression(owner))) {
    return owner.getParameters().some(parameter => bindingTextContainsName(parameter.getName(), tName));
  }
  return false;
}

function ensureNamedImport(sourceFile: SourceFile, moduleSpecifier: string, symbol: string): void {
  const imports = sourceFile.getImportDeclarations().filter(declaration => declaration.getModuleSpecifierValue() === moduleSpecifier);
  const existingNamed = imports.find(declaration => !declaration.getNamespaceImport());
  if (existingNamed) {
    const hasSymbol = existingNamed.getNamedImports().some(namedImport => namedImport.getName() === symbol && !namedImport.getAliasNode());
    if (!hasSymbol) existingNamed.addNamedImport(symbol);
    return;
  }
  sourceFile.addImportDeclaration({ moduleSpecifier, namedImports: [symbol] });
}

function validateSyntax(filePath: string, content: string): string | undefined {
  const result = ts.transpileModule(content, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX
    }
  });
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) return undefined;
  return errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ');
}

function diagnosticMessage(diagnostic: Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, '\n');
}

function diagnosticIdentity(diagnostic: Diagnostic): string {
  const source = diagnostic.getSourceFile();
  return JSON.stringify({
    code: diagnostic.getCode(),
    file: source?.getFilePath() ?? '',
    message: diagnosticMessage(diagnostic)
  });
}

function diagnosticCounts(diagnostics: Diagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const identity = diagnosticIdentity(diagnostic);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function newlyIntroducedDiagnostics(before: Map<string, number>, after: Diagnostic[]): Diagnostic[] {
  const remaining = new Map(before);
  const introduced: Diagnostic[] = [];
  for (const diagnostic of after) {
    const identity = diagnosticIdentity(diagnostic);
    const count = remaining.get(identity) ?? 0;
    if (count > 0) {
      if (count === 1) remaining.delete(identity);
      else remaining.set(identity, count - 1);
    } else {
      introduced.push(diagnostic);
    }
  }
  return introduced;
}

function projectDiagnosticsByResult(
  project: Project,
  projectRoot: string,
  results: CodemodResult[]
): Map<string, Diagnostic[]> {
  const resultByAbsolutePath = new Map(
    results.map(result => [path.resolve(projectRoot, result.filePath), result.filePath] as const)
  );
  const grouped = new Map(results.map(result => [result.filePath, [] as Diagnostic[]] as const));

  for (const diagnostic of project.getPreEmitDiagnostics()) {
    const source = diagnostic.getSourceFile();
    if (!source) continue;
    const resultPath = resultByAbsolutePath.get(path.resolve(source.getFilePath()));
    if (!resultPath) continue;
    grouped.get(resultPath)!.push(diagnostic);
  }
  return grouped;
}

function validateProjectChanges(
  config: ScannerConfig,
  projectRoot: string,
  results: CodemodResult[]
): void {
  const tsconfigPath = config.codemod?.tsconfigPath;
  if (!tsconfigPath) return;

  const resolvedTsconfig = path.resolve(projectRoot, tsconfigPath);
  const modified = results.filter(result => result.modified && result.plannedContent !== undefined);
  if (modified.length === 0) return;

  try {
    if (!fs.existsSync(resolvedTsconfig)) {
      throw new Error(`Configured tsconfig was not found: ${resolvedTsconfig}`);
    }
    const project = new Project({ tsConfigFilePath: resolvedTsconfig });
    const baselineDiagnostics = projectDiagnosticsByResult(project, projectRoot, modified);
    const baseline = new Map(
      modified.map(result => [
        result.filePath,
        diagnosticCounts(baselineDiagnostics.get(result.filePath) ?? [])
      ] as const)
    );

    for (const result of modified) {
      const absoluteFile = path.resolve(projectRoot, result.filePath);
      project.createSourceFile(absoluteFile, result.plannedContent!, { overwrite: true });
    }

    const plannedDiagnostics = projectDiagnosticsByResult(project, projectRoot, modified);
    for (const result of modified) {
      const introduced = newlyIntroducedDiagnostics(
        baseline.get(result.filePath) ?? new Map<string, number>(),
        plannedDiagnostics.get(result.filePath) ?? []
      );
      if (introduced.length === 0) continue;

      result.success = false;
      result.modified = false;
      result.plannedContent = undefined;
      result.error = `Project TypeScript validation introduced ${introduced.length} diagnostic(s): ${introduced
        .slice(0, 5)
        .map(diagnostic => `${diagnostic.getCode()}: ${diagnosticMessage(diagnostic)}`)
        .join('; ')}`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const result of modified) {
      result.success = false;
      result.modified = false;
      result.plannedContent = undefined;
      result.error = `Project TypeScript validation failed: ${message}`;
    }
  }
}

function keyForBinding(globalKey: string, binding: TranslationBinding): { key?: string; reason?: string } {
  if (binding.type !== 'known' || !binding.namespace) return { key: globalKey };
  const prefix = `${binding.namespace}.`;
  if (!globalKey.startsWith(prefix)) {
    return {
      reason: `Existing translator is scoped to namespace '${binding.namespace}', but planned key '${globalKey}' is outside that namespace`
    };
  }
  const relative = globalKey.slice(prefix.length);
  if (!relative) {
    return { reason: `Planned key '${globalKey}' has no namespace-relative segment` };
  }
  return { key: relative };
}

export function selectFixableFindings(findings: Finding[], options: Pick<CodemodOptions, 'confidence' | 'findingId'>): Finding[] {
  const rank: Record<Exclude<Confidence, 'ignored'>, number> = { low: 0, medium: 1, high: 2 };
  const minimum = rank[options.confidence];
  return findings.filter(finding => {
    if (finding.confidence === 'ignored' || !finding.autoFixCandidate || finding.fixability !== 'safe') return false;
    if (options.findingId && finding.id !== options.findingId) return false;
    return rank[finding.confidence] >= minimum;
  });
}

export function isTranslationFunctionAvailable(node: Node, tFuncName: string): boolean {
  const config = {
    i18n: {
      translationFunctionName: tFuncName,
      clientHook: 'useTranslations',
      serverAsyncFunction: 'getTranslations'
    }
  } as ScannerConfig;
  return findVisibleTranslationBinding(node, config).type === 'known';
}

export class CodemodEngine {
  private readonly config: ScannerConfig;
  private readonly projectRoot: string;

  constructor(config: ScannerConfig, projectRoot = process.cwd()) {
    this.config = config;
    this.projectRoot = path.resolve(projectRoot);
  }

  public planCodemods(findings: Finding[], targetFiles: string[], options: CodemodOptions): CodemodResult[] {
    if (!this.config.features.codemod) {
      throw new Error('Codemod feature is disabled. Set features.codemod=true to enable source transformations.');
    }
    const framework = this.config.codemod?.framework ?? 'generic';
    if (framework !== 'next-intl') {
      throw new Error(`Automatic codemods are currently production-supported only for next-intl; configured framework is '${framework}'.`);
    }

    const selected = selectFixableFindings(findings, options);
    const byFile = new Map<string, Finding[]>();
    for (const finding of selected) {
      const group = byFile.get(finding.filePath) ?? [];
      group.push(finding);
      byFile.set(finding.filePath, group);
    }

    const results: CodemodResult[] = [];
    for (const absoluteFile of targetFiles.map(file => path.resolve(file)).sort()) {
      const relativePath = path.relative(this.projectRoot, absoluteFile).replace(/\\/g, '/');
      const fileFindings = byFile.get(relativePath);
      if (!fileFindings?.length) continue;

      const project = new Project({ compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX } });
      const sourceFile = project.addSourceFileAtPath(absoluteFile);
      const result: CodemodResult = {
        filePath: relativePath,
        success: true,
        modified: false,
        blocked: [],
        patches: []
      };

      try {
        const targets = fileFindings
          .map(finding => ({ finding, node: findNodeAtLineAndColumn(sourceFile, finding.line, finding.column) }))
          .sort((a, b) => b.finding.line - a.finding.line || b.finding.column - a.finding.column);
        const injections = new Map<Block, PlannedInjection>();
        const plannedTargets: { finding: Finding; node: Node; globalKey: string; callKey: string }[] = [];

        for (const target of targets) {
          const { finding, node } = target;
          if (!node) {
            result.blocked.push({ findingId: finding.id, reason: 'Finding location no longer resolves to an AST node' });
            continue;
          }

          const globalKey = options.keyOverrides?.[finding.id] ?? finding.suggestedKey;
          if (!globalKey) {
            result.blocked.push({ findingId: finding.id, reason: 'No catalog key is available for this finding' });
            continue;
          }

          const binding = findVisibleTranslationBinding(node, this.config);
          if (binding.type === 'unknown') {
            result.blocked.push({
              findingId: finding.id,
              reason: `A '${this.config.i18n.translationFunctionName}' binding exists but is not a recognized next-intl translator`
            });
            continue;
          }

          const boundKey = keyForBinding(globalKey, binding);
          if (!boundKey.key) {
            result.blocked.push({ findingId: finding.id, reason: boundKey.reason ?? 'Unable to resolve translation key for visible binding' });
            continue;
          }

          if (binding.type === 'missing') {
            const component = findEnclosingComponent(node);
            if (!component) {
              result.blocked.push({ findingId: finding.id, reason: 'No enclosing React component was found for safe translator injection' });
              continue;
            }
            if (scopeHasOwnTranslationName(component.block, this.config.i18n.translationFunctionName)) {
              result.blocked.push({
                findingId: finding.id,
                reason: `Component '${component.name}' already declares '${this.config.i18n.translationFunctionName}' in its scope`
              });
              continue;
            }
            if (component.async && !this.config.features.insertServerTranslations) {
              result.blocked.push({ findingId: finding.id, reason: 'Server translation insertion is disabled by configuration' });
              continue;
            }
            if (!component.async && !this.config.features.insertClientTranslations) {
              result.blocked.push({ findingId: finding.id, reason: 'Client/shared translation insertion is disabled by configuration' });
              continue;
            }
            injections.set(component.block, { block: component.block, async: component.async });
          }

          plannedTargets.push({ finding, node, globalKey, callKey: boundKey.key });
        }

        for (const target of plannedTargets) {
          const { finding, node, callKey } = target;
          const tName = this.config.i18n.translationFunctionName;
          const originalLine = sourceFile.getFullText().split(/\r?\n/)[finding.line - 1] ?? '';
          let replacement: string;
          if (finding.fixStrategy === 'replace-jsx-text') {
            replacement = `{${tName}("${callKey}")}`;
          } else if (finding.fixStrategy === 'replace-jsx-attribute') {
            replacement = Node.isJsxExpression(node.getParent()) ? `${tName}("${callKey}")` : `{${tName}("${callKey}")}`;
          } else {
            result.blocked.push({ findingId: finding.id, reason: `Unsupported fix strategy '${finding.fixStrategy ?? 'none'}'` });
            continue;
          }
          node.replaceWithText(replacement);
          result.modified = true;
          const modifiedLine = sourceFile.getFullText().split(/\r?\n/)[finding.line - 1] ?? '';
          result.patches.push({ line: finding.line, original: originalLine.trim(), modified: modifiedLine.trim() });
        }

        for (const injection of injections.values()) {
          if (injection.async) {
            ensureNamedImport(sourceFile, 'next-intl/server', this.config.i18n.serverAsyncFunction);
            injection.block.insertStatements(0, `const ${this.config.i18n.translationFunctionName} = await ${this.config.i18n.serverAsyncFunction}();`);
          } else {
            ensureNamedImport(sourceFile, 'next-intl', this.config.i18n.clientHook);
            injection.block.insertStatements(0, `const ${this.config.i18n.translationFunctionName} = ${this.config.i18n.clientHook}();`);
          }
        }

        if (result.modified) {
          const plannedContent = sourceFile.getFullText();
          const syntaxError = validateSyntax(absoluteFile, plannedContent);
          if (syntaxError) {
            result.success = false;
            result.error = `Generated source is syntactically invalid: ${syntaxError}`;
            result.modified = false;
          } else {
            result.plannedContent = plannedContent;
          }
        }
        if (result.blocked.length > 0) result.success = false;
        results.push(result);
      } catch (error) {
        result.success = false;
        result.error = error instanceof Error ? error.message : String(error);
        results.push(result);
      }
    }

    validateProjectChanges(this.config, this.projectRoot, results);
    return results;
  }

  public applyCodemods(findings: Finding[], targetFiles: string[], options: CodemodOptions): CodemodResult[] {
    const results = this.planCodemods(findings, targetFiles, options);
    if (!options.dryRun) {
      const blocked = results.filter(result => !result.success);
      if (blocked.length > 0) {
        throw new Error(`Refusing to write codemods because ${blocked.length} file(s) contain blocked or invalid transformations`);
      }
      writeFilesAtomically(
        results
          .filter(result => result.modified && result.plannedContent !== undefined)
          .map(result => ({
            filePath: path.resolve(this.projectRoot, result.filePath),
            content: result.plannedContent!
          }))
      );
    }
    return results;
  }
}
