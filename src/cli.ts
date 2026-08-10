import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, DEFAULT_CONFIG } from './config.js';
import { Scanner } from './scanner.js';
import { Reporter } from './reporter.js';
import { Extractor } from './extractor.js';
import { CodemodEngine } from './codemod.js';
import { CacheManager } from './cache.js';
import type { ScanReport, Finding, Confidence } from './types.js';

function getGitChangedFiles(): string[] {
  try {
    const output = execSync('git status --porcelain', { encoding: 'utf8' });
    return output
      .split(/\r?\n/)
      .map(line => line.slice(3).trim())
      .filter(line => line.length > 0)
      .map(line => path.resolve(process.cwd(), line))
      .filter(file => fs.existsSync(file));
  } catch (e) {
    console.error('Error running git status. Make sure git is installed and this is a git repository.');
    return [];
  }
}

function getGitFilesSince(branch: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${branch}`, { encoding: 'utf8' });
    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => path.resolve(process.cwd(), line))
      .filter(file => fs.existsSync(file));
  } catch (e) {
    console.error(`Error running git diff since ${branch}.`);
    return [];
  }
}

const program = new Command();

program
  .name('i18n-scan')
  .description('Enterprise i18n Hardcoded String Detector')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize default i18n-scan.config.json configuration')
  .action(() => {
    const configPath = path.resolve(process.cwd(), 'i18n-scan.config.json');
    if (fs.existsSync(configPath)) {
      console.error('i18n-scan.config.json already exists.');
      process.exit(1);
    }
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    console.log('Created i18n-scan.config.json with default configuration.');
  });

program
  .command('scan', { isDefault: true })
  .description('Scan project for hardcoded strings')
  .option('--json <path>', 'Path to save JSON report')
  .option('--markdown <path>', 'Path to save Markdown report')
  .option('--sarif <path>', 'Path to save SARIF report')
  .option('--fail-on-new', 'Fail if new high-confidence findings are found compared to baseline')
  .option('--baseline <path>', 'Path to baseline file', 'i18n-scan.baseline.json')
  .option('--confidence <level>', 'Minimum confidence level (high, medium, low)', 'low')
  .option('--files <paths>', 'Comma-separated list of specific files to scan')
  .option('--changed', 'Scan only changed files in Git status')
  .option('--since <branch>', 'Scan only files changed since specified Git branch')
  .option('--no-cache', 'Disable caching of scan results')
  .option('--clear-cache', 'Clear existing scan cache')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    const config = loadConfig(options.config);

    if (options.clearCache) {
      const cacheManager = new CacheManager(process.cwd());
      cacheManager.clear();
      console.log('Cache cleared successfully.');
    }

    const scanner = new Scanner(config);

    let targetFiles: string[] = [];
    if (options.files) {
      targetFiles = options.files.split(',').map((f: string) => path.resolve(process.cwd(), f.trim()));
    } else if (options.changed) {
      const changed = getGitChangedFiles();
      const allowed = new Set(await scanner.getTargetFiles());
      targetFiles = changed.filter(f => allowed.has(f));
      console.log(`Found ${targetFiles.length} changed files matching scanner configuration.`);
    } else if (options.since) {
      const changed = getGitFilesSince(options.since);
      const allowed = new Set(await scanner.getTargetFiles());
      targetFiles = changed.filter(f => allowed.has(f));
      console.log(`Found ${targetFiles.length} changed files since ${options.since} matching scanner configuration.`);
    } else {
      targetFiles = await scanner.getTargetFiles();
    }

    if (targetFiles.length === 0) {
      console.log('No files found matching the configuration.');
      process.exit(0);
    }

    console.log(`Scanning ${targetFiles.length} files...`);
    const useCache = options.cache !== false;
    const report = scanner.scanFiles(targetFiles, useCache);

    // Apply confidence level filter
    const minConfidence = options.confidence as Confidence;
    const confidenceOrder: Confidence[] = ['low', 'medium', 'high'];
    const minIdx = confidenceOrder.indexOf(minConfidence);

    // Filter findings if necessary
    if (minIdx > 0) {
      report.findings = report.findings.filter(f => {
        if (f.confidence === 'ignored') return true; // keep ignored findings
        const idx = confidenceOrder.indexOf(f.confidence);
        return idx >= minIdx;
      });
      // Recalculate summary
      const active = report.findings.filter(f => f.confidence !== 'ignored');
      report.summary.totalFindings = active.length;
      report.summary.highConfidence = active.filter(f => f.confidence === 'high').length;
      report.summary.mediumConfidence = active.filter(f => f.confidence === 'medium').length;
      report.summary.lowConfidence = active.filter(f => f.confidence === 'low').length;
      report.summary.autoFixCandidates = active.filter(f => f.autoFixCandidate).length;
      report.summary.needsReview = active.filter(f => f.needsReview).length;
    }

    const reporter = new Reporter(report);

    // Output reports if specified
    if (options.json) {
      reporter.save('json', path.resolve(process.cwd(), options.json));
      console.log(`Saved JSON report to ${options.json}`);
    }
    if (options.markdown) {
      reporter.save('markdown', path.resolve(process.cwd(), options.markdown));
      console.log(`Saved Markdown report to ${options.markdown}`);
    }
    if (options.sarif) {
      reporter.save('sarif', path.resolve(process.cwd(), options.sarif));
      console.log(`Saved SARIF report to ${options.sarif}`);
    }

    // Default: print summary to terminal
    if (!options.json && !options.markdown && !options.sarif) {
      console.log(reporter.toMarkdown());
    }

    // Check suppression reasons
    if (report.suppressions.withoutReason > 0) {
      console.error(`Error: Found ${report.suppressions.withoutReason} suppression comments without a specified reason.`);
      process.exit(1);
    }

    // Fail-on-new baseline comparison
    if (options.failOnNew) {
      const baselinePath = path.resolve(process.cwd(), options.baseline);
      let baselineIds = new Set<string>();

      if (fs.existsSync(baselinePath)) {
        try {
          const content = fs.readFileSync(baselinePath, 'utf8');
          const baselineData = JSON.parse(content);
          if (baselineData && Array.isArray(baselineData.findings)) {
            baselineData.findings.forEach((f: any) => baselineIds.add(f.id));
          } else if (Array.isArray(baselineData)) {
            baselineData.forEach((id: string) => baselineIds.add(id));
          }
        } catch (e: any) {
          console.warn(`Warning: Failed to parse baseline file at ${baselinePath}. Treating as empty.`);
        }
      } else {
        console.log(`Baseline file not found at ${options.baseline}. All findings are treated as new.`);
      }

      // Check if any current high confidence finding is new
      const newHighConfidenceFindings = report.findings.filter(
        f => f.confidence === 'high' && !baselineIds.has(f.id)
      );

      if (newHighConfidenceFindings.length > 0) {
        console.error(`\nError: Found ${newHighConfidenceFindings.length} new high-confidence hardcoded string findings:`);
        newHighConfidenceFindings.forEach(f => {
          console.error(`  - ${f.filePath}:${f.line} [${f.kind}]: "${f.rawText || f.normalizedText}"`);
        });
        console.error(`\nPlease resolve these findings or update your baseline.`);
        process.exit(1);
      } else {
        console.log('No new high-confidence hardcoded strings found. CI check passed!');
      }
    }

    process.exit(0);
  });

program
  .command('extract')
  .description('Extract hardcoded strings to translation catalog')
  .option('--locale <locale>', 'Target locale (e.g. en, fr)', 'en')
  .option('--merge', 'Merge new entries into the existing catalog file')
  .option('--dry-run', 'Perform dry-run and print results without modifying files')
  .option('--files <paths>', 'Comma-separated list of specific files to scan')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    const config = loadConfig(options.config);
    const scanner = new Scanner(config);

    let targetFiles: string[] = [];
    if (options.files) {
      targetFiles = options.files.split(',').map((f: string) => path.resolve(process.cwd(), f.trim()));
    } else {
      targetFiles = await scanner.getTargetFiles();
    }

    if (targetFiles.length === 0) {
      console.log('No files found matching the configuration.');
      process.exit(0);
    }

    const report = scanner.scanFiles(targetFiles);
    const extractor = new Extractor(config);

    console.log(`Extracting catalog for locale: ${options.locale}...`);
    const collisions = extractor.extractCatalog(report.findings, options.merge, options.dryRun);

    console.log('\n--- Catalog Extraction Summary ---');
    console.log(`New entries found: ${collisions.newEntries.length}`);
    console.log(`Similar values reusing existing keys: ${collisions.similarValues.length}`);
    console.log(`Key collisions detected: ${collisions.keyCollisions.length}`);
    console.log(`Already existing matched keys: ${collisions.existingMatches.length}`);

    if (collisions.keyCollisions.length > 0) {
      console.warn('\nWarning: The following key collisions were detected (same key suggested for a different value):');
      collisions.keyCollisions.forEach(c => {
        console.warn(`  - Key: "${c.key}" | Existing: "${c.oldValue}" | New: "${c.newValue}" in ${c.filePath}`);
      });
      console.warn('These collisions were NOT merged. Please review and rename keys manually.');
    }

    if (collisions.newEntries.length > 0) {
      if (options.merge) {
        if (options.dryRun) {
          console.log('\n[Dry-run] Would add the following new entries:');
        } else {
          console.log('\nSuccessfully merged the following new entries:');
        }
        collisions.newEntries.forEach(entry => {
          console.log(`  - "${entry.key}": "${entry.value}"`);
        });
      } else {
        console.log('\nNew entries (run with --merge to save to catalog):');
        collisions.newEntries.forEach(entry => {
          console.log(`  - "${entry.key}": "${entry.value}"`);
        });
      }
    }

    if (collisions.similarValues.length > 0) {
      console.log('\nSuggestions for reuse (existing values matched under different keys):');
      collisions.similarValues.forEach(s => {
        console.log(`  - Re-use key "${s.existingKey}" for value "${s.value}" instead of creating "${s.key}" in ${s.filePath}`);
      });
    }

    process.exit(0);
  });

program
  .command('apply')
  .description('Safely and conservatively apply codemods to refactor high-confidence strings')
  .option('--write', 'Write modifications directly to source files (default: dry-run)')
  .option('--dry-run', 'Dry-run mode, print patches without writing (default)')
  .option('--confidence <level>', 'Minimum confidence level to apply', 'high')
  .option('--files <paths>', 'Only apply to these comma-separated files')
  .option('--changed', 'Apply only to changed files in Git status')
  .option('--since <branch>', 'Apply only to files changed since specified Git branch')
  .option('--no-cache', 'Disable caching of scan results')
  .option('--finding-id <id>', 'Only apply specific finding ID')
  .option('--config <path>', 'Path to configuration file')
  .action(async (options) => {
    const config = loadConfig(options.config);
    const scanner = new Scanner(config);

    let targetFiles: string[] = [];
    if (options.files) {
      targetFiles = options.files.split(',').map((f: string) => path.resolve(process.cwd(), f.trim()));
    } else if (options.changed) {
      const changed = getGitChangedFiles();
      const allowed = new Set(await scanner.getTargetFiles());
      targetFiles = changed.filter(f => allowed.has(f));
    } else if (options.since) {
      const changed = getGitFilesSince(options.since);
      const allowed = new Set(await scanner.getTargetFiles());
      targetFiles = changed.filter(f => allowed.has(f));
    } else {
      targetFiles = await scanner.getTargetFiles();
    }

    if (targetFiles.length === 0) {
      console.log('No files found to modify.');
      process.exit(0);
    }

    const useCache = options.cache !== false;
    const report = scanner.scanFiles(targetFiles, useCache);
    const codemod = new CodemodEngine(config);

    const isDryRun = !options.write || options.dryRun === true;

    console.log(`${isDryRun ? '[Dry-run] ' : ''}Applying codemods to ${targetFiles.length} files...`);
    const results = codemod.applyCodemods(report.findings, targetFiles, {
      dryRun: isDryRun,
      confidence: options.confidence,
      findingId: options.findingId
    });

    let totalModified = 0;
    for (const res of results) {
      if (res.modified) {
        totalModified++;
        console.log(`\nModified: ${res.filePath}`);
        for (const patch of res.patches) {
          console.log(`  Line ${patch.line}:`);
          console.log(`  - ${patch.original}`);
          console.log(`  + ${patch.modified}`);
        }
      }
      if (!res.success && res.error) {
        console.error(`Error in ${res.filePath}: ${res.error}`);
      }
    }

    console.log(`\nCodemod completed. Total files modified: ${totalModified}`);
    process.exit(0);
  });

program.parse(process.argv);
