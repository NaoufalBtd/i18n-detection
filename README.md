# i18n-scan

`i18n-scan` is an AST-based detector for hardcoded user-facing source copy in JavaScript, TypeScript, and React code. It is intentionally conservative: detection can be heuristic, while automatic writes are restricted to transformations the tool can validate deterministically.

## Safety model

The tool separates three concepts that should not be confused:

- **confidence**: how likely a finding is genuinely user-facing text;
- **fixability**: whether the source transformation is safe to automate;
- **catalog planning**: whether a deterministic translation key can be created or reused without collisions.

A high-confidence finding is not automatically safe to rewrite. Local constants, object properties, presentation models, validation messages, metadata, conditionals, concatenations, template literals, translation fallbacks, and inline locale maps remain review-oriented unless the source semantics can be preserved safely.

Only findings marked `fixability: safe` are eligible to create catalog entries automatically. This prevents audit findings from producing unused translation keys.

## Detection coverage

The scanner includes sink-local React detection and a bounded semantic pass for common production patterns:

- direct JSX text;
- configured JSX attributes and component props;
- known notification/toast arguments;
- same-file constants and objects used by UI sinks;
- conditionals, template literals, and string concatenation;
- translation fallback arguments such as `t(key, fallback)`;
- `next-intl`-style `defaultValue` source copy;
- translation-shaped hooks and presentation objects;
- presenter, adapter, and table-label factories;
- inline locale maps such as `en` / `fr` / `ar` objects;
- Zod-style validation messages;
- Next.js metadata source copy;
- local `useState` messages when the corresponding state is rendered in JSX;
- templates that combine translated expressions with remaining hardcoded fragments.

Semantic rules are designed to avoid treating technical literals such as status enums, routes, telemetry event names, style tokens, and protocol identifiers as translation keys merely because they are strings.

## Commands

```bash
pnpm build
node dist/cli.js scan
node dist/cli.js scan --changed --fail-on-new
node dist/cli.js scan --sarif artifacts/i18n.sarif
node dist/cli.js extract --dry-run
node dist/cli.js extract --merge
node dist/cli.js apply
node dist/cli.js apply --write
```

`apply` is dry-run by default. Source files and all affected source-locale catalogs are planned together and, with `--write`, committed as one atomic file transaction. If any selected transformation is unsafe, namespaced ambiguously, syntactically invalid, or collides in any catalog, nothing is written.

## Configuration

Initialize a configuration with:

```bash
node dist/cli.js init
```

The default integration targets `next-intl` and scans conventional single-package and monorepo roots:

```json
{
  "include": [
    "src/**/*.{js,jsx,ts,tsx}",
    "apps/*/src/**/*.{js,jsx,ts,tsx}",
    "packages/*/src/**/*.{js,jsx,ts,tsx}"
  ],
  "i18n": {
    "library": "next-intl",
    "sourceLocale": "en",
    "translationFunctionName": "t",
    "clientHook": "useTranslations",
    "serverAsyncFunction": "getTranslations",
    "messagesPath": "messages/{locale}.json"
  }
}
```

`{locale}` is resolved explicitly. If a catalog path does not contain `{locale}`, only the configured source locale may be targeted.

### Split catalogs

Projects that physically split catalogs by logical namespace can declare routes. The longest matching namespace wins.

For example, a project where logical keys such as `products.listing.searchAction` live physically in `storefront/products.json` as `listing.searchAction` can use:

```json
{
  "i18n": {
    "messagesPath": "messages/{locale}.json",
    "catalogRoutes": [
      {
        "namespace": "products",
        "messagesPath": "apps/web/src/locales/{locale}/storefront/products.json",
        "stripNamespace": true
      },
      {
        "namespace": "admin.categoryManagement",
        "messagesPath": "apps/web/src/locales/{locale}/admin/categoryManagement.json",
        "stripNamespace": true
      }
    ]
  }
}
```

The planner preserves the **logical global key** for findings and codemod coordination while reading and writing the **physical relative key** inside the routed file. Multiple routed catalogs are validated before any write and committed atomically as one write set.

When exactly one literal `useTranslations('namespace')` or `getTranslations('namespace')` namespace is visible in the relevant lexical scope, key generation prefers that namespace over filesystem inference. If multiple namespaces are visible, the scanner deliberately falls back to structural inference rather than guessing which translator owns a new key.

### Semantic scan rules

Semantic detection is configurable rather than hard-wired to one application architecture:

```json
{
  "semantic": {
    "translationApis": [
      {
        "callee": "t",
        "fallbackArgument": 1,
        "optionsArgument": 1,
        "defaultValueProperty": "defaultValue"
      },
      {
        "callee": "translations.t",
        "fallbackArgument": 1
      }
    ],
    "presentationFilePatterns": [
      "presentation",
      "presenter",
      "adapter",
      "translations",
      "columns"
    ],
    "presentationFunctionPatterns": [
      "^get.*Presentation$",
      "^adapt",
      "^use.*Translations$",
      "^get.*Columns$"
    ],
    "inlineLocaleKeys": ["en", "fr", "ar"],
    "scanValidationMessages": true,
    "scanNextMetadata": true
  }
}
```

Translation fallback/default-value findings are audit information by default rather than direct hardcode violations. Validation, metadata, state-flow, and general presenter findings are review-oriented. Translation-shaped objects can be classified with higher confidence because their purpose is explicit.

### Automatic source rewriting

Automatic source rewriting is opt-in:

```json
{
  "features": {
    "codemod": true,
    "insertClientTranslations": true,
    "insertServerTranslations": true
  },
  "codemod": {
    "framework": "next-intl"
  }
}
```

The production write path currently supports `next-intl`. The scanner can use a visible namespace to generate and route a logical key, but the codemod still deliberately refuses to rewrite through an already-scoped translator such as `useTranslations('Orders')`. Converting a global planned key into a namespace-relative call is a separate mutation-semantic decision and remains blocked rather than guessed.

## Suppressions

Suppressions are recognized only from actual source comments, not string contents.

```ts
// i18n-scan-ignore-next-line -- external protocol requires this literal
const label = 'OK';

// i18n-scan-ignore-start -- legacy widget pending migration
// ...
// i18n-scan-ignore-end
```

A reason is required. Unreasoned suppressions fail the scan policy check.

## Baselines

`--fail-on-new` supports scan-report baselines and legacy arrays of finding IDs. New reports include a semantic `fingerprint` so findings remain stable when unrelated line numbers move.

```bash
node dist/cli.js scan --json i18n-scan.baseline.json
node dist/cli.js scan --fail-on-new --baseline i18n-scan.baseline.json
```

The CI gate remains intentionally focused: `--fail-on-new` fails for new **high-confidence** findings. Medium- and low-confidence semantic audit findings remain visible without turning every presenter fallback or validation message into a release blocker.

## Cache correctness

The local cache is invalidated by:

- file content hash;
- complete scanner configuration hash;
- cache schema version;
- scanner engine version.

The cache therefore cannot silently preserve findings after rule/configuration changes merely because a file timestamp stayed unchanged.

## Git-aware scanning

Full scans use configured glob rules and, when running inside Git, intersect candidates with `git ls-files -co --exclude-standard`. This delegates nested `.gitignore`, negation, escaping, and tracked-file behavior to Git instead of reimplementing Git ignore semantics.

`--changed` and `--since` invoke Git through argument arrays rather than shell interpolation.

## Exit codes

- `0`: command completed successfully;
- `1`: findings/policy prevented the requested operation;
- `2`: configuration, Git, parsing, or operational failure.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Golden fixture files are read-only during tests. Missing expected fixtures fail rather than silently blessing current output.
