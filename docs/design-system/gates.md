# Design-system gates

Each gate below says what it catches and, more usefully, what it is blind to.
A gate you have only ever seen green is an untested assumption.

Two tiers, and the split is deliberate. The cheap tier -- types, lint, unit --
runs in [CI](../../.github/workflows/ci.yml) and in
[lefthook](../../lefthook.yml)'s pre-commit. The expensive tier -- the Storybook
visual suite, its Linux leg, and `pnpm acceptance:visual` -- is local only, on
purpose: it needs a built Storybook, a Docker image and a human looking at the
PNGs, and a gate that blocks a push on a 17-minute render nobody reviews is a
gate people learn to skip.

## Types: `pnpm check`

[package.json](../../package.json) runs the server and frontend TypeScript
projects, then `pnpm check:svelte`. The latter uses `svelte-check` with
`--fail-on-warnings`, so `.svelte` templates are part of the gate. This catches
invalid props and template types. It cannot tell whether a legal class paints
the intended colour, whether focus moves correctly, or whether a story depicts
the promised state. The command uses `&&`, so an earlier failure can prevent
later type checks from running.

## Static rules: `pnpm lint`

Biome followed by three repo-specific checks.

| Check | Catches | Blind spots |
| --- | --- | --- |
| Biome | Configured formatting, lint and import diagnostics | Rendered appearance, browser interaction and unconfigured rules |
| [check-design-tokens.mjs](../../scripts/check-design-tokens.mjs) | Numeric arbitrary z-index, arbitrary rgba shadows, raw palette colours and white/black opacity tints in listed interaction states | Scans frontend `.svelte` and `.ts`, not CSS; raw hex and arbitrary radius only warn; it does not enforce all spacing or colour decisions. Reasoned interaction-state waivers are supported. |
| [check-component-ownership.mjs](../../scripts/check-component-ownership.mjs) | Native control bypasses, `bg-accent` anchors, important class overrides, named UI imports and named global control recipes; fails both increased counts and stale exceptions | Regex and naming conventions, not computed styles or intent. UI, fixtures, stories and debug components are excluded. Per-file counts can stay unchanged while a violation moves. |
| [check-class-token-drop.mjs](../../scripts/check-class-token-drop.mjs) | Classes removed from changed `.svelte`/`.ts` files without a retained token or waiver. A move waiver rechecks destination tokens and the declared call-site trigger. | Default scope is uncommitted changes against HEAD; `--since main` compares branch commits. It uses literal extraction, exempts plumbing tokens and does not prove which element wears a retained class. It cannot validate pixels. |

For the token-drop example, the script records `font-brand` and `py-3` vanishing
from AttachMenu during migration. Types and ownership still passed. A mention
of the token in a comment is not preservation. Lint chains with `&&`, so a
Biome failure can prevent the custom checks from running.

## Combined fast gate: `pnpm verify`

[verify.mjs](../../scripts/verify.mjs) spawns `pnpm check`, `pnpm lint` and
`pnpm test:unit` together, waits with `Promise.all`, reports each job and prints
the last 4,000 characters of every failing job's output. One failed job does
not hide failures from the other two. It exits nonzero if any job fails.
This adds no new coverage and does not undo the short-circuiting inside check
or lint, nor does it run the browser visual or acceptance tests. What it buys is
the habit: cheap enough to run once per commit rather than once per ticket. A
unit-test failure introduced by commit `mkah` survived three commits because the
suite was only being run at ticket boundaries.

One caveat on the token-drop check inside it: its default scope is the
uncommitted diff, so on a clean checkout it finds nothing and passes. That makes
it a pre-commit tool in practice and a no-op in CI. Use `--since main` to audit
a whole branch.

## Unit tests and duplicate baselines

`pnpm test:unit` runs the projects in [vitest.config.ts](../../vitest.config.ts),
including component tests in jsdom and unit/fixture tests. These catch asserted
logic and DOM regressions, not real browser layout.

[visual-baseline-uniqueness.test.ts](../../test/unit/visual-baseline-uniqueness.test.ts)
hashes committed PNG bytes, grouped by viewport and platform. It rejects
undeclared duplicate story groups and stale allowlist entries. Its motivating
failure was ChatLayout stories capturing ConnectOverlay instead of their own
content. It reads saved files; it does not render today's source, detect missing
baselines, or identify equal decoded pixels in differently encoded PNGs.
Legitimate stories ending in the same frame need a reasoned allowlist entry.

## Storybook visuals and the two tolerance traps

[components.spec.ts](../../test/visual/components.spec.ts) discovers the built
Storybook index, waits for story rendering and `play()`, checks render errors,
freezes animations and compares screenshots. It catches visual changes in the
states actually captured. Its exclusions, unrepresented states, themes and
nonvisual behaviour remain outside that proof. A green comparison against a
stale build also says nothing about newer source.

There are two separate ways a small regression can disappear:

1. [playwright.config.ts](../../test/visual/playwright.config.ts) allows
   `maxDiffPixelRatio: 0.01` normally. At 1440 by 900 that is 12,960 pixels.
   `VISUAL_STRICT=1` sets the per-pixel threshold and both difference budgets
   to zero, and disables retries. Zero pixel budget alone would still allow
   colour drift below the default per-pixel threshold.
2. `--update-snapshots` defaults to `changed`, which respects those tolerances.
   A successful recapture can leave an existing, slightly wrong PNG untouched.
   [update-visual-snapshots.sh](../../scripts/update-visual-snapshots.sh) records
   this failure and explicitly sets strict mode on both platforms.

Set `VISUAL_STRICT=1` on every check leg and every recapture. Build once when
no visual run is using the output, then check it without rebuilding:

```sh
pnpm storybook:build
VISUAL_STRICT=1 pnpm exec playwright test --config test/visual/playwright.config.ts
```

For intentional changes, `pnpm test:storybook-visual:update-all` builds once
and recaptures the screenshot spec on macOS, then Linux. Review the PNGs and
run strict comparisons afterward; capture success is not comparison success.
The older `test:storybook-visual:update` command does not set strict itself.

## Linux and committed PNGs

The update script mounts this checkout at `/work` in the official
`mcr.microsoft.com/playwright:v<minor>.0-noble` image with `linux/amd64` and
`VISUAL_STRICT=1`. It derives the image version from the installed Playwright
package. Docker must be running. The container serves the same built Storybook.

For the Linux check leg, use that same image, mount and environment, running
`npx playwright test --config test/visual/playwright.config.ts` without
`--update-snapshots`. Omit the screenshot-spec filter when checking the full
visual suite so behaviour-only specs run too. Keep both `*-darwin.png` and
`*-linux.png`: fonts and rasterisation differ by platform, and comparisons need
the matching baseline. One platform's green run cannot certify the other.

## Product acceptance: `pnpm acceptance:visual`

[acceptance-visual.sh](../../scripts/acceptance-visual.sh) builds the frontend,
starts a strict-port Vite preview, parses its listed Gherkin features into JSON
IR, dry-checks them, generates entrypoints and executes them. The
[acceptance runtime](../../acceptance/README.md) mocks WebSocket traffic and
checks functional behaviour and selected visual regions. This catches product
wiring missed by isolated stories, but cannot prove real provider integration
or scenarios outside that feature list.

Run it before claiming completion for changes covered by `features/*.feature`,
including composer layout, styling, test IDs, the acceptance runtime or its
baselines. Use `pnpm acceptance:visual:capture` only for intentional changes,
review the PNGs, then run the check against the real baselines. Storybook's
`VISUAL_STRICT` setting does not replace acceptance's own comparison rules.

## Build and reporting hazards

[vite.config.ts](../../vite.config.ts) resolves `outDir` to `dist/frontend`
and sets `emptyOutDir: true`. `pnpm build:frontend` and `pnpm test:e2e` therefore
do not empty `dist/storybook`; they are safe from that output-directory race.
This is not a promise about unrelated resource or port contention.

Treat `pnpm storybook:build` as an exclusive writer of `dist/storybook`.
Never run it while any host or Docker visual run is reading that directory.
The visual runner loads its index and serves assets from there, so rebuilding
can invalidate an in-flight run. Wait for all readers to finish before building
or using an update command that builds first.

Keep the exit status and the complete reporter log. As an additional review
step, grep the reporter summary for failed, passed and skipped counts, and
inspect each failure. Do not infer success from a wrapper's exit status alone
or count every occurrence of the word `failed` as a separate test. No evidence
for a general Playwright exit-code defect was found in the inspected source.

## bits-ui upgrade watch

`bits-ui` is exactly pinned to `2.18.1` in package.json and the lockfile.
Its locked peer requirement is Svelte `^5.33.0`, so review it together with
Svelte 5 compatibility. Upgrades are deliberate dependency changes: update the
pin and lockfile together, run the fast gates and asserting stories, then run
the full strict visual suite on both darwin and linux. Review any intentional
recaptures and repeat both comparisons. Also run acceptance when the affected
controls participate in its product scenarios. A type-compatible upgrade can
still change focus, ARIA or pixels.
