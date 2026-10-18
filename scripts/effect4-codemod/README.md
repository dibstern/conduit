# Effect 4 mechanical codemod

Run from the Effect 3 checkout with its existing dependencies installed. The codemod uses the installed TypeScript compiler API and makes no network requests.

```sh
pnpm codemod:effect4
pnpm codemod:effect4 --patch /tmp/effect4.patch --report /tmp/effect4-report.md
pnpm codemod:effect4 --transform schema --write
```

The default is a dry run. `--write` applies changes. Reports default to `test-results/effect4-codemod-report.md` and `.json`. The JSON includes exact UTF-16 source ranges, original text, replacements, rules and reference citations. `--patch` writes a dependency-free unified patch using whole-file hunks. Reports and patches have no timestamps or machine-specific root paths.

`--transform` accepts a comma-separated list and can be repeated. Available families are `imports`, `services`, `generators`, `layers`, `catch`, `either`, `fork`, `option`, `schema`, `testing`, and `core`. `--root` selects another v3 checkout. Repeated `--project` flags override the default root and frontend tsconfigs, which together cover `src` and `test`.

## Safety

Every source edit starts from an AST node and a checker-resolved Effect export. Alias resolution follows import and re-export symbols. Local names stay unchanged. Import rewrites preserve local aliases. Either field rewrites additionally prove the actual field declaration and discriminant belong to Effect, so a local `right` field on an intersection stays untouched.

Rules and source-line citations are in [rules.mjs](rules.mjs). The [reference directory](reference/README.md) contains unchanged, hashed upstream copies pinned to `effect@4.0.5` and a specific Effect-TS/skills revision. Ambiguous destinations, unsupported overloads, structural or behavioral changes, and unimplemented API-map rows appear as skipped sites in the report.

`deferred.json` records additional files dropped from each transform after independent v4 measurements exposed diagnostics outside that transform. The codemod reports every deferred site and leaves that family unchanged in those files. Deferrals are deliberately conservative: a changed file is deferred if its transitive importers contain newly introduced diagnostics. This avoids treating errors exposed by restored type inference as a successful migration. Deferrals can be regenerated with `prune.mjs` after measuring a new candidate. They reduce coverage; they do not establish that the underlying upstream mapping is wrong.

Svelte scripts are parsed with the existing Svelte dependency solely to locate imports and references. They have no TypeScript checker program here, so all their sites are reported and left unchanged. TS files named `*.svelte.ts` are ordinary compiler inputs.

`Context.Tag` class forms and function-style `GenericTag` can be mechanical. `Effect.Tag` classes are converted only when local, empty and free of accessor/constructor consumers. Exported accessor classes and bundled `Effect.Service` constructors need manual review. Schema filters are limited to one-argument boolean predicates or refinements without v3 metadata parameters or annotation options. Tuple rest overloads, mixed null literals, explicit constructor generics and spread arguments are reported. Either import expressions are deferred because their qualifiers and namespace consumers require coordinated migration.

The codemod does not upgrade dependencies or complete the behavioral Effect migration.

## Measurement

```sh
node scripts/effect4-codemod/measure.mjs
```

The harness copies this checkout beneath the system temporary directory, excluding Git internals, dependencies and generated output. It pins `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/opentelemetry`, and `@effect/vitest` to `4.0.5`, removes the four consolidated packages, and installs with network access. Only this measurement step needs network.

It runs `pnpm exec tsc --noEmit --pretty false --project ...` for both tsconfigs before and after each family. Each family starts from the original v3 sources, while the checker always runs in the original v3 checkout to generate the patch. The harness applies that patch with `git apply` and verifies the resulting bytes against the JSON edits. The original checkout is never rewritten. The scratch copy is removed in `finally` unless `--keep-scratch` is explicitly requested.

[MEASUREMENTS.md](MEASUREMENTS.md) and [measurements.json](measurements.json) record totals, diagnostic codes, semantic categories, deltas and newly introduced diagnostics. Categories use v3 checker-backed API anchors plus compiler messages; callback bodies retain their own category. Diagnostic matching accounts for moved text and line offsets. A family passes only if total and own-category errors fall and no diagnostic is introduced outside its category. Families with no remaining applicable sites are marked unmeasured, not passing.

Development commands can reuse an installed scratch copy with `--scratch DIR --skip-install --keep-scratch`, select a family with `--transform NAME`, or reclassify retained compiler logs with `--reclassify-logs`. `--prune` conservatively defers failing files and remeasures, up to four attempts per family. If combined measurement adds deferrals, repeat all families against the final manifest. `prune.mjs --dry-run` shows conservative exclusions without changing them. Raw logs, patches and reports live in `test-results/effect4-codemod-measurements/`.

```sh
node scripts/effect4-codemod/self-check.mjs
```

This separate offline check copies the v3 sources, adds a type-checked collision probe, runs every transform twice and compares hashes of the entire `src`, `test` and `acceptance` trees. It verifies that local `catchAll`, `Either` and `Literal` names and a colliding intersection field stay unchanged, while aliased Effect symbols migrate. The second run must report zero edits. [SAFETY.json](SAFETY.json) records the proof; the temporary source copy is removed automatically.
