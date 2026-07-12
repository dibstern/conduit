# UBM Acceptance Pipeline — conduit Playwright Visual Install Plan

Date: 2026-07-12
Target: conduit Svelte 5 SPA (`src/lib/frontend/`), visual acceptance via Playwright.

This plan installs the portable UBM acceptance-test pipeline
(https://github.com/unclebob/Acceptance-Pipeline-Specification, vendored in the
`ubm-acceptance-pipeline-specification` skill) into conduit. The pipeline turns
a Gherkin feature file into JSON IR, generates a thin executable test
entrypoint, runs it, and mutates example values to measure test strength.

The **gym app** (`/Users/dstern/src/personal/gym/app`) is the concrete
TypeScript blueprint. gym drives **Maestro against an iOS simulator**; conduit
swaps the driver to **the Playwright `chromium` library against the built
conduit web app**. Everything else — parser tools, JSON IR, generator, runtime,
step-handler dispatch, runner-worker NDJSON protocol, scripts, metadata,
implementation_hash — transfers structurally unchanged.

Key design principle (from `references/browser-e2e-adapter.md` and
`acceptance-generator.md`): the generated entrypoint is **thin**. It loads the
IR, calls the runtime, and routes steps to project handlers that reuse
conduit's existing Playwright **page objects** (`test/e2e/page-objects/*`) and
**visual helpers** (`test/e2e/helpers/visual-helpers.ts`). No parallel browser
harness is reimplemented inside the acceptance runtime.

---

## 1. Directory Layout to Create

```
conduit/
  features/
    composer-send-button.feature          # first feature (see §8)
  acceptance/
    bin/
      acceptance-entrypoint-generator.ts  # IR -> generated entrypoint + metadata
      acceptance-runner-worker.ts         # persistent NDJSON mutation worker
    src/
      apsTypes.ts                         # ApsFeature/ApsScenario/ApsStep (verbatim from gym)
      exampleExpansion.ts                 # expandFeature + resolveStepText (verbatim from gym)
      runtime.ts                          # runFeature(feature, handlers, lifecycle) — Playwright world
      stepHandlers.ts                     # conduit Gherkin -> Playwright actions/assertions
      playwrightDriver.ts                 # browser/context/page lifecycle + region screenshot compare
      visualMode.ts                       # 'assert' | 'capture' (verbatim from gym)
    generated/                            # generated entrypoints + metadata/ (git-ignored, rebuilt)
    visual/
      baselines/<viewport>/               # approved PNG baselines
      artifacts/                          # diff/actual PNGs from failed runs (git-ignored)
  build/
    acceptance/{ir,dry}/                  # parser + dry-checker output (git-ignored)
    acceptance-mutation/                  # mutator work dir: base/, generated/, mutations/ (git-ignored)
    aps-tools/bin/                        # built gherkin-parser / -ir-dry-checker / -mutator (git-ignored)
  scripts/
    acceptance-env.sh                     # PATH setup for aps-tools + app-under-test server
    acceptance-visual.sh                  # normal acceptance run
    acceptance-mutation-visual.sh         # mutation run
    install-aps-tools.sh                  # build/vendor the portable Go (or bb) tools
  tools/                                  # OPTIONAL: vendor bb.edn+bb/ and go/ from the skill
```

Add to `.gitignore`: `build/`, `acceptance/generated/`, `acceptance/visual/artifacts/`.

**Portable tools**: copy `tools/` from the skill
(`~/.agents/skills/ubm-acceptance-pipeline-specification/tools/`) — Go sources
at `tools/go/`, Babashka at `tools/bb.edn`+`tools/bb/`. `install-aps-tools.sh`
builds the three Go binaries (`gherkin-parser`, `gherkin-ir-dry-checker`,
`gherkin-mutator`) into `build/aps-tools/bin` via `go install`. Prefer building
from the vendored `tools/go/` over gym's clone-from-upstream approach so the
install is offline and pinned. Both toolsets have zero external deps.

---

## 2. JSON IR Shape (from `parser-spec.md`)

The generator/runtime/mutator all consume this canonical shape (all values are
strings, even numbers/booleans):

```json
{
  "name": "Feature name",
  "background": [{ "keyword": "Given", "text": "…", "parameters": [] }],
  "scenarios": [
    {
      "name": "Scenario name",
      "steps": [{ "keyword": "Then", "text": "the send button is <enabled>", "parameters": ["enabled"] }],
      "examples": [{ "message": "hello", "enabled": "true" }]
    }
  ]
}
```

- `background` optional (`[]` when absent); runtime prepends it to every execution.
- `examples` empty ⇒ scenario runs once with `{}` and **cannot** be mutated.
- `parameters` derived from `<…>` placeholders in `text`; `text` is authoritative.
- Mutator only ever changes an **example cell** at
  `$.scenarios[i].examples[j].<key>` (zero-based). Never names, steps, keywords,
  background, or headers.

Mirrors gym's `acceptance/src/apsTypes.ts` exactly — copy that file verbatim.

---

## 3. Entrypoint Generator (`acceptance/bin/acceptance-entrypoint-generator.ts`)

**Contract** (`acceptance-generator.md`): `acceptance-entrypoint-generator <json-ir> <generated-test-output>`, exit `0` ok / `1` error / `2` usage. Deterministic for fixed IR. Must embed/load the IR, run every scenario execution, delegate all step behavior to runtime+handlers, and write per-feature metadata with an `implementation_hash` over generated files only.

**gym approach** (`app/acceptance/bin/acceptance-entrypoint-generator.ts`):
- Derives `stem` from the IR basename and locates `features/<stem>.feature`.
- Emits one `acceptance/generated/<stem>.acceptance.ts` — a standalone `tsx`
  script (NOT a `@playwright/test` spec) that reads `ACCEPTANCE_IR_PATH`
  (fallback `argv[2]`), `JSON.parse`s the IR into `ApsFeature`, and calls
  `runFeature(feature, handlers, lifecycle)` inside a `main()` that
  `process.exit(0|1)`.
- Writes `generated/metadata/<slug>.json` where `slug =
  featurePath.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')`.
- `implementation_hash = "sha256:" + sha256(for each sorted generated file:
  relPath + \0 + fileBytes + \0)` — see gym `hashGeneratedFiles`.

**conduit adaptation**: near-verbatim copy. Only changes:
1. The generated import line binds conduit handlers/lifecycle:
   `import { conduitVisualHandlers, conduitVisualLifecycle } from '<stepHandlers>'`.
2. Generated content stays **tied to scenario structure, not example values**
   (already true — gym embeds no example literals), so the same entrypoint runs
   mutated IR without regeneration. Keep the `ACCEPTANCE_IR_PATH` env indirection.
3. Metadata object unchanged: `{ schema_version:1, feature_path, ir_path,
   implementation_hash, hash_scope:"generated_files", generated_files:[…] }`.

The hash **must not** include stepHandlers, runtime, driver, app source, parser,
or mutator files — only the emitted `*.acceptance.ts`. (This is what lets the
mutator reuse manifest results when only handlers change under `soft` level.)

---

## 4. Runtime + Step Handlers

### Runtime (`acceptance/src/runtime.ts`, `exampleExpansion.ts`)

`expandFeature` and `resolveStepText` copy from gym **verbatim** — they are
project-neutral:
- `expandFeature`: for each scenario, `examples.length ? examples : [{}]`; one
  `ScenarioExecution` per row; `steps = [...background, ...scenario.steps]`.
- `resolveStepText`: replaces `<key>` from the example object; missing key throws
  (→ test failure, per spec rule 9/10).

`runFeature` keeps gym's structure — fresh `world` per execution, ordered step
dispatch, first-matching-handler by regex, `afterScenario` lifecycle — but the
**world type** changes for Playwright:

```ts
export type AcceptanceWorld = {
  page: import('@playwright/test').Page;   // live page for the current execution
  driver: PlaywrightDriver;                // browser/context owner + region compare
  artifacts: string[];                     // diff/actual PNG paths on failure
  // scenario-scoped scratch (selected component, last-typed text, etc.)
};
```

Unlike gym (which accumulates Maestro commands into `world.commands` and flushes
by shelling out to `maestro`), conduit **drives the browser live**: handlers
call `world.page` directly. The lifecycle opens a fresh browser **context+page**
before each execution and closes it in `afterScenario` (parallels gym's
per-scenario simulator seed/cleanup). The browser + app server stay hot across
executions (see §5/§7).

### `playwrightDriver.ts`

Owns the hot browser and the region-screenshot comparison (the Playwright analog
of gym's `maestro/` package):
- `launch()`: `chromium.launch()` once (imported from `@playwright/test`, which
  re-exports it — no test runner needed).
- `newExecution()`: fresh `context` (with `colorScheme:'dark'`, fixed viewport
  from a `VIEWPORT` env like the visual configs) + `page`; returns the page.
- `matchRegion(page, regionId, baseline, threshold, mode)`: screenshot the
  locator, then in `assert` mode compare to
  `acceptance/visual/baselines/<viewport>/<baseline>.png` via **pixelmatch**
  (reuse `test/e2e/helpers/visual-helpers.ts` `compareImages` /
  `freezeAnimations` / `waitForFonts`); in `capture` mode write the baseline.
  This replaces Maestro's `takeScreenshot` visual assertion. (We cannot use
  `expect().toHaveScreenshot()` because we run outside the `@playwright/test`
  runner, but pixelmatch+pngjs are already conduit deps and used exactly this
  way in `test/e2e/specs/visual-mockup.spec.ts`.)

### Step handlers (`acceptance/src/stepHandlers.ts`)

Same shape as gym: an array of `{ name, match: RegExp, run({world,text,match,example}) }`.
Prefer regex with placeholder-name capture (spec §"Step Handler Contract").
Handlers map Gherkin → Playwright actions/assertions on `world.page`, reusing
existing page objects:

| Gherkin step (example) | Playwright behavior |
|---|---|
| `the conduit app is served with the <recording> mockup` | `driver.newExecution()`; apply WS mock (`ws-mock.ts` `mockRelayWebSocket`) with the named canned state; `page.goto('/')`; wait for `#layout` + `#connect-overlay` hidden (`gotoRelay` pattern). |
| `I type <message> into the composer` | `new InputPage(page)` → `page.fill('#input', message)` |
| `I clear the composer` | `page.fill('#input', '')` |
| `the send button is <enabled>` | assert `#send` enabled/disabled matches `enabled==='true'` |
| `the <region_id> region visually matches <baseline> at <threshold> percent` | `await driver.matchRegion(page, regionId, baseline, Number(threshold), mode)`; push artifact path on mismatch |

Handler rules (spec §"Step Handler Contract"): fresh world per execution;
fetch placeholder values **by name** from `example`; parse strings to types
(`"true"` → boolean, `"98"` → number); missing/malformed/unsupported → throw
(fails the current test). Keep patterns narrow so unrelated steps don't collide.
`conduitVisualLifecycle.afterScenario` closes the page/context and, on failure,
persists diff/actual PNGs from `world.artifacts`.

---

## 5. Runner Adapter — Persistent NDJSON Worker (`acceptance/bin/acceptance-runner-worker.ts`)

**Protocol** (`mutator-spec.md` §"Runner Adapter"): the mutator starts up to
`--workers` worker processes once and streams jobs. Copy gym's worker
(`app/acceptance/bin/acceptance-runner-worker.ts`) near-verbatim.

Stdin — one JSON **job** per line:
```json
{ "id":"m1", "feature_json":"…/mutations/m1/feature.json",
  "generated_dir":"…/generated", "work_dir":"…/mutations/m1", "timeout":"30s" }
```
Stdout — one JSON **response** per line (nothing else on stdout):
```json
{ "id":"m1", "outcome":"test_failure", "output":"…", "error":"", "duration":125000000 }
```
Rules: each input line = one job; each output line = one response; **no
non-protocol data on stdout** (diagnostics → stderr); if the worker exits, its
in-flight job becomes `error`.

Outcome mapping → classification:
`test_success`→survived, `test_failure`→killed, `infrastructure_error`→error.

`defaultExecuteJob` (the only real change from gym): spawn a fresh entrypoint
process per job pointing at the mutated IR — keeping the browser/app-server hot
comes from the long-lived server (§7), exactly as gym relies on a booted
simulator while each `tsx` job is fresh:
```
tsx acceptance/generated/composer-send-button.acceptance.ts <feature_json>
   env ACCEPTANCE_IR_PATH=<feature_json>
```
exitCode 0 → `test_success`; stderr contains `INFRASTRUCTURE_ERROR:` → `infrastructure_error`; else `test_failure`. Keep gym's timeout/abort/process-group-kill logic verbatim.

Note: gym uses `execa`; conduit does **not** depend on execa. Either add `execa`
or use `node:child_process` `spawn` (small rewrite of `defaultExecuteJob`).
Recommend `node:child_process` to avoid a new dep.

---

## 6. Scripts

### `scripts/acceptance-env.sh`
Puts `build/aps-tools/bin` on PATH. Unlike gym (Java for Maestro) conduit needs
no JVM; instead ensure the built frontend exists (`pnpm build:frontend`) and
export the app-under-test port (see §7).

### `scripts/acceptance-visual.sh` (normal run — mirrors gym `acceptance-visual.sh`)
```sh
#!/bin/sh
set -eu
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT_DIR"
. "$ROOT_DIR/scripts/acceptance-env.sh"
pnpm build:frontend
# start hot app server (§7), trap-stop on exit
rm -rf build/acceptance/ir build/acceptance/dry acceptance/generated acceptance/visual/artifacts
mkdir -p build/acceptance/ir build/acceptance/dry acceptance/generated acceptance/visual/artifacts
gherkin-parser        features/composer-send-button.feature build/acceptance/ir/composer-send-button.json
gherkin-ir-dry-checker build/acceptance/ir/composer-send-button.json build/acceptance/dry/composer-send-button.json
pnpm exec tsx acceptance/bin/acceptance-entrypoint-generator.ts \
  build/acceptance/ir/composer-send-button.json acceptance/generated
pnpm exec tsx acceptance/generated/composer-send-button.acceptance.ts \
  build/acceptance/ir/composer-send-button.json
```
Requirements (SKILL §"Normal Acceptance Script"): stop on first failure; create
dirs first; never run generated tests directly against the `.feature` — always
regenerate from IR. Capture baselines with `VISUAL_ACCEPTANCE_MODE=capture`.

### `scripts/acceptance-mutation-visual.sh` (mirrors gym `acceptance-mutation-visual.sh`)
Strip any `# mutation-stamp` / `# acceptance-mutation-manifest-*` lines from the
feature (awk, with an EXIT trap to re-strip), start the hot app server, then:
```sh
gherkin-parser features/composer-send-button.feature build/acceptance-mutation/base/composer-send-button.json
pnpm exec tsx acceptance/bin/acceptance-entrypoint-generator.ts \
  build/acceptance-mutation/base/composer-send-button.json build/acceptance-mutation/generated
gherkin-mutator \
  --feature features/composer-send-button.feature \
  --work-dir build/acceptance-mutation \
  --generated-dir build/acceptance-mutation/generated \
  --runner-worker "pnpm exec tsx acceptance/bin/acceptance-runner-worker.ts" \
  --workers "${ACCEPTANCE_MUTATION_WORKERS:-1}" \
  --timeout "${ACCEPTANCE_MUTATION_TIMEOUT:-45m}" "$@"
```
Wire into `package.json`: `acceptance:tools`, `acceptance:visual`,
`acceptance:visual:capture`, `acceptance:mutation:visual` (mirrors gym).

---

## 7. How the App-Under-Test Is Served

**Reuse conduit's existing visual harness: `vite preview` + mocked WebSocket.**
This is the `test/e2e/playwright-visual.config.ts` path:
- `pnpm exec vite preview --port 4173 --strictPort` serves the built frontend
  (from `pnpm build:frontend`). Started **once** by the acceptance/mutation
  script and torn down on exit — the conduit analog of gym's booted simulator
  that stays hot across jobs.
- No real OpenCode/relay. Each scenario execution's `page` gets a mocked
  relay WebSocket via `test/e2e/helpers/ws-mock.ts` `mockRelayWebSocket`, seeded
  with canned state (extend `test/e2e/fixtures/mockup-state.ts`). This is the
  deterministic, backend-free path `browser-e2e-adapter.md` recommends
  ("deterministic replay fixtures or a local mock backend"), and it is exactly
  how `test/e2e/specs/visual-mockup.spec.ts` already drives the live app.
- The generated entrypoint navigates to `http://localhost:4173` (via a
  `CONDUIT_BASE_URL` env, default `http://localhost:4173`).

**Alternative (heavier, more realistic):** the replay harness
`createReplayHarness(recording)` in `test/e2e/helpers/e2e-harness.ts` starts a
real `RelayStack` + `MockOpenCodeServer` serving `dist/frontend` on a dynamic
URL per test, driven by a named `.opencode.json.gz` recording. Better for
backend-driven features, but per-execution startup cost and dynamic URLs
complicate the "hot server" model. Recommend vite-preview+ws-mock for the first
feature; revisit replay when a feature needs real session/message flow.

Determinism helpers before every screenshot (already in `visual-helpers.ts`):
`waitForFonts`, `waitForIcons`, `freezeAnimations`, and dynamic-text
normalization (see `visual-mockup.spec.ts`).

---

## 8. First Feature Proposal

**Component:** the message composer / input area — `#input` and `#send` in
`src/lib/frontend/components/` (page object `test/e2e/page-objects/input.page.ts`;
existing visual spec `test/visual/input-area.spec.ts` and a storybook story, so
baselines are feasible). Chosen because the send-button-enable behavior is pure
frontend, fully deterministic, needs no backend response, and its example cells
(`message`, `enabled`, `threshold`) are natural mutation targets.

`features/composer-send-button.feature`:
```gherkin
Feature: Composer send button reflects input content

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: send button enables only when the composer has text
  When I type <message> into the composer
  Then the send button is <enabled>

Examples:
  | message      | enabled |
  | hello world  | true    |
  | fix the bug  | true    |
  |              | false   |

Scenario Outline: the composer matches the approved layout
  When I type <message> into the composer
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | message     | baseline                | threshold |
  | hello world | composer-with-text-dark | 98        |
```

Why these mutations bite: flipping `enabled` `true`→`false` (boolean rule) must
be **killed** by the assertion; dithering `message` to `""`-like content or
mutating `threshold` `98`→something else exercises whether the visual assertion
is genuinely wired. A surviving `enabled` mutation means the send-button
assertion is not really connected — the whole point of the mutation gate.

---

## 9. Open Risks / Decisions (conduit diverges from gym)

1. **Live-drive vs command-accumulation.** gym batches Maestro commands and
   shells out once per flush; conduit drives `world.page` live. Cleaner, but the
   runtime's world now owns a real browser page and the lifecycle must reliably
   close contexts (leak risk under parallel mutation workers). Decision: open
   context in `newExecution`, always close in `afterScenario`.
2. **No `@playwright/test` runner.** The generated entrypoint is a plain `tsx`
   script using `chromium` from `@playwright/test`. We therefore lose
   `toHaveScreenshot()` auto-baselines/retries and reimplement compare via
   pixelmatch (already a dep). Acceptable; matches `visual-mockup.spec.ts`.
3. **Baseline determinism.** Web screenshots are noisier than simulator ones
   (fonts, sub-pixel AA, animations, cursor). Must apply `freezeAnimations` +
   font/icon waits + dynamic-text normalization and pick a threshold/maxDiff
   tolerance (existing configs use `maxDiffPixels:50` / `maxDiffPixelRatio:0.01`).
   Baselines are viewport- and colorScheme-specific → store under
   `baselines/<viewport>/` and pin `VIEWPORT`/`colorScheme` in the driver.
4. **execa dependency.** gym's worker uses `execa`; conduit lacks it. Decision:
   rewrite `defaultExecuteJob` on `node:child_process` to avoid a new dep
   (keep gym's timeout/process-group-kill semantics).
5. **App-server model.** vite-preview+ws-mock is deterministic but only exercises
   frontend + canned WS; features needing real session/message flow will need
   the replay harness, whose dynamic per-test URL fights the "one hot server"
   assumption. Deferred until a feature demands it.
6. **Tool runtime.** No JVM/Babashka assumed; build the Go binaries from the
   vendored `tools/go/`. If Go is unavailable in CI, fall back to `bb`. Pin via
   `tools/UPSTREAM`; build offline from vendored sources (not gym's git-clone).
7. **`INFRASTRUCTURE_ERROR:` signaling.** Handlers must distinguish a real
   assertion failure (killed) from harness breakage (browser launch failure,
   server down → error) by printing `INFRASTRUCTURE_ERROR:` to stderr, or every
   flaky launch pollutes the mutation score as false `killed`/`survived`.
8. **Manifest/stamp in-file mutation.** The mutator rewrites the `.feature` with
   a manifest/stamp comment block; conduit lint/format or pre-commit hooks may
   fight this. The mutation script strips them before each run (gym pattern);
   ensure the feature file is excluded from Prettier/format-on-save churn.
```
