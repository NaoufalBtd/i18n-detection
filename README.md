# i18n-scan

`i18n-scan` is an AST-based detector for hardcoded user-facing strings in TypeScript and React code. It is intentionally conservative: detection can be heuristic, while automatic writes are restricted to transformations the tool can validate deterministically.

## Safety model

The tool separates three concepts that should not be confused:

- **confidence**: how likely a finding is genuinely user-facing text;
- **fixability**: whether the source transformation is safe to automate;
- **catalog planning**: whether a deterministic translation key can be created or reused without collisions.

A high-confidence finding is not automatically safe to rewrite. Local constants, object properties, conditionals, concatenations, and template literals remain review-oriented until their source semantics can be preserved safely.

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

`apply` is dry-run by default. Source files and the source-locale catalog are planned together and, with `--write`, committed as one atomic file transaction. If any selected transformation is unsafe, namespaced ambiguously, syntactically invalid, or collides in the catalog, nothing is written.

## Configuration

Initialize a configuration with:

```bash
node dist/cli.js init
```

The default integration targets `next-intl` and uses:

```json
{
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

`{locale}` is resolved explicitly. If the path does not contain `{locale}`, only the configured source locale may be targeted.

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

The production write path currently supports `next-intl`. A configured namespaced translator such as `useTranslations('Orders')` is deliberately not rewritten because a generated global key cannot be safely converted into a namespace-relative key without a stronger catalog model.

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
