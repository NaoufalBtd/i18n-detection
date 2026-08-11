#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig, DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';
import { Reporter } from './reporter.js';
import { Extractor, type LocaleParityIssue } from './extractor.js';
import { CodemodEngine, selectFixableFindings } from './codemod.js';
import { CacheManager } from './cache.js';
import { writeFilesAtomically } from './io.js';
import { TOOL_VERSION } from './version.js';
import type { ScanReport, Finding, Confidence, ScannerConfig } from './types.js';

class CliError extends Error {
  constructor(message: string, public readonly exitCode = 2) {
    super(message);
    this.name = 'CliError';
  }
}

function runGit(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Git command failed: git ${args.join(' ')}\n${message}`);
  }
}

function getGitChangedFiles(): string[] {
  const records = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\0')
    .filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const fileName = record.slice(3);
    files.push(path.resolve(process.cwd(), fileName));
    if (/[RC]/.test(status) && index + 1 < records.length) index++;
  }
  return files.filter(file => fs.existsSync(file));
}

function getGitFilesSince(branch: string): string[] {
  const commit = runGit(['rev-parse', '--verify', `${branch}^{commit}`]).trim();
  if (!commit) throw new CliError(`Unable to resolve Git ref '${branch}'`);
  return runGit(['diff', '--name-only', '-z', `${commit}...HEAD`, '--'])
    .split('\0')
    .filter(Boolean)
    .map(file => path.resolve(process.cwd(), file))
    .filter(file => fs.existsSync(file));
}

function parseConfidence(value: string): Exclude<Confidence, 'ignored'> {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  throw new CliError(`Invalid confidence '${value}'. Expected high, medium, or low.`);
}

function recalculateSummary(report: ScanReport): void {
  const active = report.findings.filter(finding => finding.confidence !== 'ignored');
  report.summary.filesWithFindings = new Set(active.map(finding => finding.filePath)).size;
  report.summary.totalFindings = active.length;
  report.summary.highConfidence = active.filter(finding => finding.confidence === 'high').length;
  report.summary.mediumConfidence = active.filter(finding => finding.confidence === 'medium').length;
  report.summary.lowConfidence = active.filter(finding => finding.confidence === 'low').length;
  report.summary.autoFixCandidates = active.filter(finding => finding.autoFixCandidate).length;
  report.summary.needsReview = active.filter(finding => finding.needsReview).length;
}

function filterReportByConfidence(report: ScanReport, minimum: Exclude<Confidence, 'ignored'>): void {
  const rank: Record<Exclude<Confidence, 'ignored'>, number> = { low: 0, medium: 1, high: 2 };
  const threshold = rank[minimum];
  report.findings = report.findings.filter(finding =>
    finding.confidence === 'ignored' ? true : rank[finding.confidence] >= threshold
  );
  recalculateSummary(report);
}

async function resolveTargetFiles(
  scanner: Scanner,
  options: { files?: string; changed?: boolean; since?: string }
): Promise<string[]> {
  const allowed = new Set((await scanner.getTargetFiles()).map(file => path.resolve(file)));
  let candidates: string[];
  if (options.files) {
    candidates = options.files.split(',').map(file => path.resolve(process.cwd(), file.trim()));
  } else if (options.changed) {
    candidates = getGitChangedFiles();
  } else if (options.since) {
    candidates = getGitFilesSince(options.since);
  } else {
    candidates = [...allowed];
  }
  return [...new Set(candidates.map(file => path.resolve(file)))].filter(file => allowed.has(file)).sort();
}

function semanticFingerprint(finding: Partial<Finding>): string | undefined {
  if (!finding.filePath || !finding.kind) return undefined;
  const identity = JSON.stringify({
    filePath: finding.filePath,
    kind: finding.kind,
    text: finding.texts ?? finding.normalizedText,
    context: finding.userFacingContext,
    variableName: finding.variableName,
    propertyName: finding.propertyName
  });
  return `i18n-v1:${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

function loadBaseline(filePath: string): { ids: Set<string>; fingerprints: Set<string> } {
  if (!fs.existsSync(filePath)) return { ids: new Set(), fingerprints: new Set() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to parse baseline at ${filePath}: ${message}`);
  }

  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  if (Array.isArray(parsed)) {
    for (const item of parsed) if (typeof item === 'string') ids.add(item);
    return { ids, fingerprints };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { findings?: unknown }).findings)) {
    throw new CliError(`Baseline at ${filePath} must be an array of IDs or a scan report with a findings array`);
  }

  for (const item of (parsed as { findings: unknown[] }).findings) {
    if (!item || typeof item !== 'object') continue;
    const finding = item as Partial<Finding>;
    if (typeof finding.id === 'string') ids.add(finding.id);
    if (typeof finding.fingerprint === 'string') fingerprints.add(finding.fingerprint);
    else {
      const migrated = semanticFingerprint(finding);
      if (migrated) fingerprints.add(migrated);
    }
  }
  return { ids, fingerprints };
}

function enrichTranslationCatalogStatus(config: ScannerConfig, report: ScanReport): Extractor {
  const extractor = new Extractor(config);
  extractor.enrichTranslationFindings(report.findings, config.i18n.sourceLocale);
  return extractor;
}

function reportCatalogPlan(plan: ReturnType<Extractor['planCatalogs']>[number]): void {
  const route = plan.namespace ? ` (namespace ${plan.namespace}${plan.stripNamespace ? ', stripped' : ''})` : '';
  console.log(`Catalog: ${path.relative(process.cwd(), plan.catalogPath) || plan.catalogPath}${route}`);
  console.log(`New entries: ${plan.report.newEntries.length}`);
  console.log(`Existing exact-key matches: ${plan.report.existingMatches.length}`);
  console.log(`Similar-value suggestions: ${plan.report.similarValues.length}`);
  console.log(`Key collisions: ${plan.report.keyCollisions.length}`);
  console.log(`Blocked findings: ${plan.report.blockedFindings.length}`);
}

function reportCatalogPlans(plans: ReturnType<Extractor['planCatalogs']>): void {
  for (const [index, plan] of plans.entries()) {
    if (index > 0) console.log('');
    reportCatalogPlan(plan);
  }
}

function reportLocaleParityIssues(issues: LocaleParityIssue[], prefix: string): void {
  if (issues.length === 0) return;
  console.error(`${prefix} (${issues.length} issue(s)):`);
  for (const issue of issues) {
    const catalog = issue.catalogPath ? ` [${path.relative(process.cwd(), issue.catalogPath)}]` : '';
    console.error(`- ${issue.locale} ${issue.key}: ${issue.reason}${catalog}`);
  }
}

const program = new Command();
program
  .name('i18n-scan')
  .description('Production-oriented AST detector for hardcoded user-facing strings')
  .version(TOOL_VERSION);

program
  .command('init')
  .description('Initialize i18n-scan.config.json')
  .action(() => {
    const configPath = path.resolve(process.cwd(), 'i18n-scan.config.json');
    if (fs.existsSync(configPath)) throw new CliError('i18n-scan.config.json already exists.', 1);
    writeFilesAtomically([{ filePath: configPath, content: `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n` }]);
    console.log('Created i18n-scan.config.json.');
  });

program
  .command('scan', { isDefault: true })
  .description('Scan project for hardcoded strings')
  .option('--json <path>', 'Save JSON report')
  .option('--markdown <path>', 'Save Markdown report')
  .option('--sarif <path>', 'Save SARIF report')
  .option('--fail-on-new', 'Fail on new high-confidence findings compared with baseline')
  .option('--baseline <path>', 'Baseline file', 'i18n-scan.baseline.json')
  .option('--confidence <level>', 'Minimum confidence level', 'low')
  .option('--files <paths>', 'Comma-separated files; still constrained by scanner include/exclude rules')
  .option('--changed', 'Scan only changed Git files')
  .option('--since <branch>', 'Scan files changed from the merge-base with a branch/ref')
  .option('--no-cache', 'Disable scan cache')
  .option('--clear-cache', 'Clear cache before scanning')
  .option('--config <path>', 'Configuration file')
  .action(async options => {
    const config = loadConfig(options.config);
    if (options.clearCache) new CacheManager(process.cwd(), config).clear();
    const scanner = new Scanner(config);
    const targetFiles = await resolveTargetFiles(scanner, options);
    if (targetFiles.length === 0) {
      console.log('No files found matching the configuration.');
      return;
    }

    const report = scanner.scanFiles(targetFiles, options.cache !== false);
    enrichTranslationCatalogStatus(config, report);
    filterReportByConfidence(report, parseConfidence(options.confidence));
    const reporter = new Reporter(report);
    if (options.json) reporter.save('json', options.json);
    if (options.markdown) reporter.save('markdown', options.markdown);
    if (options.sarif) reporter.save('sarif', options.sarif);
    if (!options.json && !options.markdown && !options.sarif) console.log(reporter.toMarkdown());

    if (report.suppressions.withoutReason > 0) {
      console.error(`Found ${report.suppressions.withoutReason} suppression comment(s) without a reason.`);
      process.exitCode = 1;
    }

    if (options.failOnNew) {
      const baselinePath = path.resolve(process.cwd(), options.baseline);
      const baseline = loadBaseline(baselinePath);
      const newHigh = report.findings.filter(
        finding =>
          finding.confidence === 'high' &&
          !baseline.ids.has(finding.id) &&
          !baseline.fingerprints.has(finding.fingerprint)
      );
      if (newHigh.length > 0) {
        console.error(`Found ${newHigh.length} new high-confidence finding(s):`);
        for (const finding of newHigh) {
          console.error(`- ${finding.filePath}:${finding.line} ${finding.rawText ?? finding.normalizedText ?? ''}`);
        }
        process.exitCode = 1;
      } else {
        console.log('No new high-confidence findings.');
      }
    }
  });

program
  .command('extract')
  .description('Plan or merge source strings into routed locale catalogs')
  .option('--locale <locale>', 'Catalog locale; defaults to configured source locale')
  .option('--merge', 'Write safe new entries to the catalog')
  .option('--dry-run', 'Never modify files')
  .option('--files <paths>', 'Comma-separated files')
  .option('--config <path>', 'Configuration file')
  .action(async options => {
    const config = loadConfig(options.config);
    const locale = options.locale ?? config.i18n.sourceLocale;
    const scanner = new Scanner(config);
    const targetFiles = await resolveTargetFiles(scanner, options);
    if (targetFiles.length === 0) {
      console.log('No files found matching the configuration.');
      return;
    }

    const report = scanner.scanFiles(targetFiles);
    const extractor = enrichTranslationCatalogStatus(config, report);
    const plans = extractor.planCatalogs(report.findings, locale);
    reportCatalogPlans(plans);

    for (const plan of plans) {
      for (const collision of plan.report.keyCollisions) {
        console.error(`Collision ${collision.key}: '${collision.oldValue}' vs '${collision.newValue}' (${collision.filePath})`);
      }
      for (const blocked of plan.report.blockedFindings) {
        console.warn(`Review required ${blocked.filePath}: ${blocked.reason}`);
      }
      for (const similar of plan.report.similarValues) {
        console.warn(`Similar source value ${similar.filePath}: '${similar.value}' already exists at '${similar.existingKey}', but automatic semantic reuse is disabled.`);
      }
    }

    if (plans.some(plan => plan.report.keyCollisions.length > 0 || plan.report.blockedFindings.length > 0)) {
      process.exitCode = 1;
      return;
    }

    if (locale === config.i18n.sourceLocale) {
      const parityIssues = extractor.validateRequiredLocales(plans);
      if (parityIssues.length > 0) {
        reportLocaleParityIssues(parityIssues, 'Required locale follow-up');
        console.warn('Source catalog extraction may continue, but source-code mutation remains blocked until required locales contain compatible keys.');
      }
    }

    if (options.merge && !options.dryRun) {
      extractor.writePlans(plans);
      const changed = plans.filter(plan => plan.changed).length;
      console.log(changed > 0 ? `Updated ${changed} catalog(s) atomically.` : 'Catalogs already up to date.');
    }
  });

program
  .command('apply')
  .description('Plan or atomically apply safe next-intl codemods together with routed source-locale catalog updates')
  .option('--write', 'Write source and catalog changes atomically; default is dry-run')
  .option('--dry-run', 'Force dry-run')
  .option('--confidence <level>', 'Minimum confidence level', 'high')
  .option('--files <paths>', 'Comma-separated files')
  .option('--changed', 'Apply only to changed Git files')
  .option('--since <branch>', 'Apply to files changed from merge-base with branch/ref')
  .option('--no-cache', 'Disable scan cache')
  .option('--finding-id <id>', 'Apply only one finding ID')
  .option('--config <path>', 'Configuration file')
  .action(async options => {
    const config: ScannerConfig = loadConfig(options.config);
    if (!config.features.codemod) {
      throw new CliError('Codemods are disabled. Set features.codemod=true after reviewing the configured i18n framework.', 1);
    }

    const minimum = parseConfidence(options.confidence);
    const scanner = new Scanner(config);
    const targetFiles = await resolveTargetFiles(scanner, options);
    if (targetFiles.length === 0) {
      console.log('No files found to modify.');
      return;
    }

    const report = scanner.scanFiles(targetFiles, options.cache !== false);
    const extractor = enrichTranslationCatalogStatus(config, report);
    const selected = selectFixableFindings(report.findings, { confidence: minimum, findingId: options.findingId });
    if (selected.length === 0) {
      console.log('No safe auto-fix findings matched the requested scope.');
      return;
    }

    const catalogPlans = extractor.planCatalogs(selected, config.i18n.sourceLocale);
    reportCatalogPlans(catalogPlans);
    if (
      catalogPlans.some(
        plan => plan.report.keyCollisions.length > 0 || plan.report.blockedFindings.length > 0
      )
    ) {
      console.error('Refusing to plan source changes because at least one catalog plan is not deterministic.');
      process.exitCode = 1;
      return;
    }

    const parityIssues = extractor.validateRequiredLocales(catalogPlans);
    if (parityIssues.length > 0) {
      reportLocaleParityIssues(parityIssues, 'Refusing source mutation because required locales are incomplete or incompatible');
      process.exitCode = 1;
      return;
    }

    const keyOverrides = Object.assign({}, ...catalogPlans.map(plan => plan.keyByFindingId)) as Record<string, string>;
    const codemod = new CodemodEngine(config);
    const results = codemod.planCodemods(report.findings, targetFiles, {
      dryRun: true,
      confidence: minimum,
      findingId: options.findingId,
      keyOverrides
    });

    for (const result of results) {
      if (result.modified) {
        console.log(`\n${result.filePath}`);
        for (const patch of result.patches) {
          console.log(`  line ${patch.line}`);
          console.log(`  - ${patch.original}`);
          console.log(`  + ${patch.modified}`);
        }
      }
      for (const blocked of result.blocked) console.error(`Blocked ${result.filePath}: ${blocked.reason}`);
      if (result.error) console.error(`Error ${result.filePath}: ${result.error}`);
    }

    if (results.some(result => !result.success)) {
      console.error('No files were written because at least one planned transformation was unsafe or invalid.');
      process.exitCode = 1;
      return;
    }

    const isDryRun = !options.write || options.dryRun === true;
    if (isDryRun) {
      console.log('\nDry-run complete. Source, catalog, locale parity, and configured project checks passed; nothing was written.');
      return;
    }

    const writes = results
      .filter(result => result.modified && result.plannedContent !== undefined)
      .map(result => ({ filePath: path.resolve(process.cwd(), result.filePath), content: result.plannedContent! }));
    writes.push(
      ...catalogPlans
        .filter(plan => plan.changed)
        .map(plan => ({ filePath: plan.catalogPath, content: plan.outputContent }))
    );
    writeFilesAtomically(writes);
    console.log(`Atomically updated ${writes.length} file(s).`);
  });

program.parseAsync(process.argv).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof CliError ? error.exitCode : 2;
});
