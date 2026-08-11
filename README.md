# i18n-scan

`i18n-scan` is an AST-based detector for hardcoded user-facing source copy in JavaScript, TypeScript, and React code. Detection is deliberately broader than mutation: the scanner can report heuristic semantic findings, while automatic writes are limited to transformations that can be planned deterministically and validated against the configured catalog topology.

## Safety model

The tool keeps four concerns separate:

- **confidence**: how likely a finding is genuinely user-facing copy;
- **semantic rule**: why the string is considered part of the i18n surface;
- **fixability**: whether source mutation is safe to automate;
- **catalog safety**: whether a logical key can be routed, validated across required locales, and written without collisions.

A high-confidence finding is not automatically safe to rewrite. Presenter copy, validation messages, schema defaults, metadata, state messages, translation fallbacks, templates, conditionals, and inline locale maps remain review-oriented unless their source semantics can be preserved safely.

Only findings with `fixability: safe` may create catalog entries automatically.

## Detection coverage

The scanner covers sink-local React strings and bounded semantic patterns commonly found in production codebases:

- direct JSX text;
- configured JSX attributes and component props;
- known toast/notification arguments;
- same-file constants and object values used by UI sinks;
- conditional strings, templates, and concatenation;
- translation fallback arguments such as `t(key, fallback)`;
- `next-intl` `defaultValue` copy with referenced-key provenance;
- translation-shaped hooks and presenter/adapter objects;
- static UI registries, including values wrapped by `as const`, `satisfies`, assertions, non-null expressions, and parentheses;
- inline locale maps such as `en` / `fr` / `ar` objects;
- Zod validation messages;
- user-facing Zod defaults, including nested default arrays/objects;
- Next.js metadata source copy;
- local `useState` messages when the same state binding is rendered in JSX;
- templates that combine translated expressions with remaining hardcoded fragments.

Semantic findings expose both a semantic `rule` and an `expressionKind`, so policy can distinguish, for example, a validation message from the fact that it was written as a template or constant.

## Commands

```bash
pnpm build
pnpm test
pnpm bench
node dist/cli.js scan
node dist/cli.js scan --changed --fail-on-new
node dist/cli.js scan --sarif artifacts/i18n.sarif
node dist/cli.js extract --dry-run
node dist/cli.js extract --merge
node dist/cli.js apply
node dist/cli.js apply --write
```

`apply` is dry-run by default. Source files and every affected source-locale catalog are planned together. Before source mutation is allowed, required locale catalogs are checked for key presence and interpolation-placeholder compatibility. With `--write`, the approved source and catalog files are committed as one atomic write set.

## Configuration

Initialize a configuration with:

```bash
node dist/cli.js init
```

The default scanner supports conventional single-package and monorepo roots:

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
    "requiredLocales": ["en"],
    "translationFunctionName": "t",
    "clientHook": "useTranslations",
    "serverAsyncFunction": "getTranslations",
    "messagesPath": "messages/{locale}.json",
    "catalogRouting": "fallback"
  }
}
```

### Required locale safety

For applications that must remain complete in several locales, declare them explicitly:

```json
{
  "i18n": {
    "sourceLocale": "en",
    "requiredLocales": ["en", "fr", "ar"]
  }
}
```

`extract --merge` may still create source-locale entries while reporting required-locale follow-up work. `apply`, however, refuses to rewrite source code until every selected key exists in all required locales and uses the same interpolation placeholder names as the source locale.

The scanner never auto-translates missing locale values.

### Split catalogs and strict routing

Projects that physically split catalogs by runtime namespace can declare routes. The longest matching namespace wins.

```json
{
  "i18n": {
    "catalogRouting": "strict",
    "catalogRoutes": [
      {
        "namespace": "products",
        "messagesPath": "apps/web/src/locales/{locale}/storefront/products.json",
        "stripNamespace": true
      },
      {
        "namespace": "admin.homepageManagement",
        "messagesPath": "apps/web/src/locales/{locale}/admin/homepageManagement.json",
        "stripNamespace": true
      }
    ]
  }
}
```

A logical key such as `products.listing.searchAction` remains global in findings and codemod planning while being stored physically as `listing.searchAction` in `storefront/products.json`.

With `catalogRouting: "strict"`, a key that matches no configured route is blocked rather than silently falling back into a legacy/default catalog.

Several runtime namespaces may safely share one physical catalog. For example, a route for `admin.homepageManagement` can store `admin.homepageManagement.main.*` and `admin.homepageManagement.sectionForm.*` as `main.*` and `sectionForm.*` in the same JSON file.

### Existing-value reuse

Equal source-language text is **not** sufficient evidence that two messages share translation semantics. If `"Open"` already exists under another key, the extractor reports it as a similar-value suggestion but does not automatically reuse that key.

Automatic reuse occurs only when the deterministic suggested key itself already exists with the same source value, or when project configuration explicitly maps a common source string through `commonMappings`.

### Translation APIs and hooks

Translation fallback rules can describe the key argument as well as fallback/default-value locations:

```json
{
  "semantic": {
    "translationApis": [
      {
        "callee": "t",
        "keyArgument": 0,
        "fallbackArgument": 1,
        "optionsArgument": 1,
        "defaultValueProperty": "defaultValue"
      }
    ],
    "translationHooks": {
      "useProductTranslations": "products",
      "useCommonTranslations": "ui.common"
    }
  }
}
```

Fallback findings retain:

- the referenced relative key;
- the inferred translation namespace;
- the resolved global key;
- the fallback/default source value;
- source-catalog status: `present`, `missing`, or `source-mismatch`.

This makes fallback reporting useful for migration audits instead of treating every fallback as the same problem.

### Static registries and schema defaults

Semantic scanning is bounded by configurable source scopes and semantic property names. Static registries are discovered through configured variable-name patterns such as `_OPTIONS`, `_STATES`, and `_DEFINITIONS`; only user-facing properties such as `label`, `description`, `title`, and `message` are reported.

Zod `.default()` is not scanned blindly. Direct defaults are reported only when the owning schema property is configured as user-facing, while nested default arrays/objects are traversed for those same semantic property names. Technical defaults such as `grid`, `active`, and locale codes remain outside the rule by default.

### Automatic source rewriting

Automatic rewriting is opt-in:

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

The production write path currently supports `next-intl`.

If a visible translator is already scoped, a rewrite is allowed only when the global catalog key is provably inside the same namespace. For example:

```ts
const t = useTranslations('products.listing');
```

with logical key `products.listing.empty.title` is rewritten using the relative call `t('empty.title')`. A key outside `products.listing.*` is blocked.

For an additional project-level safety gate, configure a tsconfig:

```json
{
  "codemod": {
    "framework": "next-intl",
    "tsconfigPath": "apps/web/tsconfig.json",
    "requireProjectValidation": true
  }
}
```

The codemod compares TypeScript diagnostics before and after all planned source changes and rejects newly introduced diagnostics. Isolated syntax validation remains enabled regardless.

## Suppressions

Suppressions are recognized only from source comments and require a reason:

```ts
// i18n-scan-ignore-next-line -- external protocol requires this literal
const label = 'OK';

// i18n-scan-ignore-start -- legacy widget pending migration
// ...
// i18n-scan-ignore-end
```

Unreasoned suppressions fail the scan policy check.

## Baselines

`--fail-on-new` supports scan-report baselines and legacy arrays of finding IDs. Findings include semantic fingerprints so unrelated line movement does not automatically create a new baseline identity.

```bash
node dist/cli.js scan --json i18n-scan.baseline.json
node dist/cli.js scan --fail-on-new --baseline i18n-scan.baseline.json
```

The default CI policy remains focused on new **high-confidence** findings. Medium- and low-confidence semantic audit findings stay visible without turning every fallback or validation message into a release blocker.

## Cache and Git behavior

The local cache is invalidated by file content, complete scanner configuration, cache schema, and scanner engine version.

Full scans use configured globs and, inside Git repositories, intersect candidates with `git ls-files -co --exclude-standard`. `--changed` and `--since` invoke Git through argument arrays rather than shell interpolation.

## Exit codes

- `0`: command completed successfully;
- `1`: findings or policy prevented the requested operation;
- `2`: configuration, Git, parsing, or operational failure.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm bench
```

The test suite includes MediaShopping-shaped acceptance cases for split runtime catalogs, fallback provenance, wrapped UI registries, schema defaults, state-binding scope, locale parity, and namespaced codemods. The benchmark exercises a registry/state-heavy semantic source to make scanner-cost regressions observable instead of anecdotal.
