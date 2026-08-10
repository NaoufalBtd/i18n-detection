import { Project, SyntaxKind, Node, SourceFile } from 'ts-morph';
import * as path from 'node:path';
import type { Finding, ScannerConfig } from './types.js';

export interface CodemodResult {
  filePath: string;
  success: boolean;
  modified: boolean;
  error?: string;
  patches: { line: number; original: string; modified: string }[];
}

function findNodeAtLineAndColumn(sourceFile: SourceFile, line: number, column: number): Node | undefined {
  const matches = sourceFile.getDescendants().filter(desc => {
    const start = desc.getStart();
    const lc = sourceFile.getLineAndColumnAtPos(start);
    return lc.line === line && lc.column === column;
  });
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => a.getWidth() - b.getWidth());
  return matches[0];
}

export function isTranslationFunctionAvailable(node: Node, tFuncName: string): boolean {
  let curr: Node | undefined = node;
  while (curr) {
    if (
      Node.isBlock(curr) ||
      Node.isSourceFile(curr) ||
      Node.isFunctionDeclaration(curr) ||
      Node.isArrowFunction(curr) ||
      Node.isFunctionExpression(curr) ||
      Node.isMethodDeclaration(curr) ||
      Node.isConstructorDeclaration(curr)
    ) {
      const locals = curr.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      for (const local of locals) {
        if (local.getName() === tFuncName) {
          return true;
        }
      }
    }
    curr = curr.getParent();
  }
  return false;
}

function findEnclosingFunctionBlock(node: Node): Node | undefined {
  let curr: Node | undefined = node;
  while (curr) {
    if (Node.isFunctionDeclaration(curr) || Node.isMethodDeclaration(curr)) {
      return curr.getBody();
    }
    if (Node.isArrowFunction(curr) || Node.isFunctionExpression(curr)) {
      const body = curr.getBody();
      if (Node.isBlock(body)) {
        return body;
      }
    }
    curr = curr.getParent();
  }
  return undefined;
}

export class CodemodEngine {
  private config: ScannerConfig;
  private projectRoot: string;

  constructor(config: ScannerConfig, projectRoot = process.cwd()) {
    this.config = config;
    this.projectRoot = projectRoot;
  }

  public applyCodemods(
    findings: Finding[],
    targetFiles: string[],
    options: { dryRun: boolean; confidence: string; findingId?: string }
  ): CodemodResult[] {
    const project = new Project({
      compilerOptions: {
        allowJs: true,
        jsx: 1 // React
      }
    });

    const activeFindings = findings.filter(f => {
      if (f.confidence === 'ignored') return false;
      if (options.findingId && f.id !== options.findingId) return false;
      if (options.confidence === 'high' && f.confidence !== 'high') return false;
      if (options.confidence === 'medium' && f.confidence !== 'high' && f.confidence !== 'medium') return false;
      return f.autoFixCandidate;
    });

    const findingsByFile: Record<string, Finding[]> = {};
    for (const f of activeFindings) {
      if (!findingsByFile[f.filePath]) {
        findingsByFile[f.filePath] = [];
      }
      findingsByFile[f.filePath].push(f);
    }

    const results: CodemodResult[] = [];

    for (const filePath of targetFiles) {
      const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
      const fileFindings = findingsByFile[relativePath];
      if (!fileFindings || fileFindings.length === 0) continue;

      const sourceFile = project.addSourceFileAtPath(filePath);
      const originalContent = sourceFile.getFullText();

      // Sort findings by position from bottom to top to prevent coordinate shifting
      const sortedFindings = [...fileFindings].sort((a, b) => b.line - a.line || b.column - a.column);

      const result: CodemodResult = {
        filePath: relativePath,
        success: true,
        modified: false,
        patches: []
      };

      try {
        const tFuncName = this.config.i18n.translationFunctionName || 't';
        let importInjected = false;

        for (const f of sortedFindings) {
          const targetNode = findNodeAtLineAndColumn(sourceFile, f.line, f.column);
          if (!targetNode) continue;

          // Verify translation function 't' is available in scope
          if (!isTranslationFunctionAvailable(targetNode, tFuncName)) {
            let injected = false;
            const hookStatement = this.config.codemod?.hookStatement;
            const importStatement = this.config.codemod?.importStatement;

            if (hookStatement && importStatement) {
              const block = findEnclosingFunctionBlock(targetNode);
              if (block && Node.isBlock(block)) {
                block.insertStatements(0, hookStatement);
                if (!importInjected && !sourceFile.getFullText().includes(importStatement)) {
                  sourceFile.insertStatements(0, importStatement);
                  importInjected = true;
                }
                injected = true;
              }
            }
            if (!injected) continue; // Skip if we couldn't inject
          }

          const originalText = targetNode.getText();
          let replacementText = f.suggestedReplacement;

          if (!replacementText || !f.suggestedKey) continue;


          const lineText = sourceFile.getFullText().split(/\r?\n/)[f.line - 1];

          // safe substitution
          if (f.kind === 'JSXText') {
            targetNode.replaceWithText(replacementText);
            result.modified = true;
          } else if (f.kind === 'JSXAttribute' || f.kind === 'KnownComponentProp') {
            // If parent is already a JsxExpression, omit the outer braces
            if (Node.isJsxExpression(targetNode.getParent())) {
              replacementText = `${tFuncName}("${f.suggestedKey}")`;
            }
            targetNode.replaceWithText(replacementText);
            result.modified = true;
          }

          if (result.modified) {
            const modifiedLineText = sourceFile.getFullText().split(/\r?\n/)[f.line - 1];
            result.patches.push({
              line: f.line,
              original: lineText.trim(),
              modified: modifiedLineText.trim()
            });
          }
        }

        if (result.modified && !options.dryRun) {
          sourceFile.saveSync();
        }

        results.push(result);
      } catch (err: any) {
        result.success = false;
        result.error = err.message;
        results.push(result);
      }
    }

    return results;
  }
}
