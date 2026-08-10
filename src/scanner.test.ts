import { describe, it, expect } from 'vitest';
import { Scanner } from './scanner.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ScannerConfig } from './types.js';

const testConfig: ScannerConfig = {
  ...DEFAULT_CONFIG,
  scanErrors: true
};

describe('i18n AST Scanner Detectors', () => {
  it('detects direct JSX text', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      export function Component() {
        return (
          <div>
            <h1>Account settings</h1>
            <p>Manage your profile</p>
            <span>OK</span> {/* allowed string */}
            <span>·</span> {/* punctuation only */}
            <span>&nbsp; &raquo;</span> {/* html entities only */}
          </div>
        );
      }
    `;

    const report = scanner.scanInMemory('src/components/Test.tsx', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');

    expect(active).toHaveLength(2);
    expect(active[0].kind).toBe('JSXText');
    expect(active[0].rawText).toBe('Account settings');
    expect(active[0].confidence).toBe('high');
    expect(active[0].suggestedKey).toBe('test.component.accountSettings');

    expect(active[1].rawText).toBe('Manage your profile');
    expect(active[1].suggestedKey).toBe('test.component.manageYourProfile');
  });

  it('detects JSX attributes and component props', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      export function Component() {
        return (
          <div>
            <input placeholder="Search users" id="technical-id" className="flex" />
            <PageHeader title="Billing" subtitle="Manage invoices" />
            <MyCustomComponent title="Generic title" unknownProp="ignored string" />
          </div>
        );
      }
    `;

    const report = scanner.scanInMemory('src/components/Test.tsx', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');

    expect(active).toHaveLength(4);

    // input placeholder (standard user-facing attr)
    const placeholder = active.find(f => f.userFacingContext?.propName === 'placeholder');
    expect(placeholder).toBeDefined();
    expect(placeholder?.kind).toBe('JSXAttribute');
    expect(placeholder?.confidence).toBe('high');

    // PageHeader title (known component prop)
    const title = active.find(f => f.userFacingContext?.elementName === 'PageHeader' && f.userFacingContext?.propName === 'title');
    expect(title).toBeDefined();
    expect(title?.kind).toBe('KnownComponentProp');
    expect(title?.confidence).toBe('high');

    // PageHeader subtitle (known component prop but let's check subtitle in config)
    const subtitle = active.find(f => f.userFacingContext?.elementName === 'PageHeader' && f.userFacingContext?.propName === 'subtitle');
    expect(subtitle).toBeDefined();
    expect(subtitle?.kind).toBe('KnownComponentProp');
    expect(subtitle?.confidence).toBe('high');

    // MyCustomComponent title (generic user-facing prop without known component mapping)
    const customTitle = active.find(f => f.userFacingContext?.elementName === 'MyCustomComponent' && f.userFacingContext?.propName === 'title');
    expect(customTitle).toBeDefined();
    expect(customTitle?.kind).toBe('JSXAttribute');
    expect(customTitle?.confidence).toBe('medium');
  });

  it('detects known function arguments', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      export function save() {
        toast.success("Saved successfully");
        toast.error("Failed to save");
        alert("Invalid input");
        console.log("Ignore me");
      }
    `;

    const report = scanner.scanInMemory('src/utils/action.ts', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');

    expect(active).toHaveLength(3);
    expect(active[0].kind).toBe('KnownFunctionArgument');
    expect(active[0].rawText).toBe('Saved successfully');
    expect(active[0].confidence).toBe('high');

    expect(active[1].rawText).toBe('Failed to save');
    expect(active[2].rawText).toBe('Invalid input');
  });

  it('resolves same-file constants', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      const title = "Account settings";
      const ignoredUrl = "https://google.com";

      export function Page() {
        return <PageHeader title={title} url={ignoredUrl} />;
      }
    `;

    const report = scanner.scanInMemory('src/app/settings/page.tsx', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');

    expect(active).toHaveLength(1);
    const f = active[0];
    expect(f.kind).toBe('LocalConstUsedInUserFacingContext');
    expect(f.rawText).toBe('Account settings');
    expect(f.confidence).toBe('high');
    expect(f.variableName).toBe('title');
    expect(f.declarationLocation).toBeDefined();
    expect(f.declarationLocation?.line).toBe(2);
    expect(f.usageLocation?.line).toBe(6);
  });

  it('resolves local object literal properties and spreads', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      const emptyState = {
        title: "No projects found",
        description: "Create your first project",
        id: "technical-id"
      };

      export function Page() {
        return (
          <div>
            <EmptyState {...emptyState} />
            <Dialog title={emptyState.title} />
          </div>
        );
      }
    `;

    const report = scanner.scanInMemory('src/app/projects/page.tsx', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');

    // 1 spread title, 1 spread description, 1 direct title access = 3 findings
    expect(active).toHaveLength(3);

    // Direct object property access EmptyState spread title
    const spreadTitle = active.find(f => f.kind === 'LocalObjectPropertyUsedInUserFacingContext' && f.rawText === 'No projects found');
    expect(spreadTitle).toBeDefined();
    expect(spreadTitle?.confidence).toBe('high');

    const spreadDesc = active.find(f => f.kind === 'LocalObjectPropertyUsedInUserFacingContext' && f.rawText === 'Create your first project');
    expect(spreadDesc).toBeDefined();
    expect(spreadDesc?.confidence).toBe('high');
  });

  it('detects conditional expressions, template literals, and concatenation', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      const msg1 = isEditing ? "Edit project" : "Create project";
      const msg2 = \`Deleted \${count} projects\`;
      const msg3 = "Failed " + error + " occurred";

      export function Component() {
        return (
          <div>
            <Dialog title={msg1} />
            <Dialog title={msg2} />
            <Dialog title={msg3} />
          </div>
        );
      }
    `;

    const report = scanner.scanInMemory('src/components/Test.tsx', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');

    expect(active).toHaveLength(3);

    const cond = active.find(f => f.kind === 'ConditionalStringUsedInUserFacingContext');
    expect(cond).toBeDefined();
    expect(cond?.confidence).toBe('medium');
    expect(cond?.texts).toContain('Edit project');
    expect(cond?.texts).toContain('Create project');

    const temp = active.find(f => f.kind === 'TemplateLiteralUsedInUserFacingContext');
    expect(temp).toBeDefined();
    expect(temp?.confidence).toBe('high');
    expect(temp?.variables).toContain('count');
    expect(temp?.suggestedReplacement).toContain('count');

    const concat = active.find(f => f.kind === 'StringConcatenationUsedInUserFacingContext');
    expect(concat).toBeDefined();
    expect(concat?.confidence).toBe('medium');
  });

  it('detects throws of Error exceptions', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      export function validate() {
        throw new Error("User not found");
      }
    `;

    const report = scanner.scanInMemory('src/utils/validate.ts', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');

    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe('ErrorString');
    expect(active[0].confidence).toBe('low');
  });

  it('respects suppression comments', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      // i18n-scan-ignore-file -- entire file is test mock data
      export function mock() {
        return "Hardcoded mock string";
      }
    `;

    const report = scanner.scanInMemory('src/mocks/file.ts', code);
    const active = report.findings.filter(f => f.confidence !== 'ignored');
    expect(active).toHaveLength(0);
    expect(report.suppressions.total).toBe(1);
    expect(report.suppressions.withoutReason).toBe(0);
  });

  it('detects suppressions without reasons', () => {
    const scanner = new Scanner(testConfig);
    const code = `
      export function render() {
        // i18n-scan-ignore-next-line
        const text = "Some warning";
        return <div>{text}</div>;
      }
    `;

    const report = scanner.scanInMemory('src/components/View.tsx', code);
    expect(report.suppressions.total).toBe(1);
    expect(report.suppressions.withoutReason).toBe(1);
  });
});
