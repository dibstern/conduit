# Acceptance Pipeline (UBM)

Portable acceptance-test pipeline based on the
[Acceptance Pipeline Specification](https://github.com/unclebob/Acceptance-Pipeline-Specification).
It turns Gherkin feature files into JSON IR, generates executable acceptance
tests, runs them, and runs acceptance mutation to measure test strength.

conduit targets the **Svelte frontend with Playwright-based visual acceptance**.

## Pipeline

```text
features/*.feature
  -> gherkin-parser        -> build/acceptance/ir/*.json        (JSON IR)
  -> gherkin-ir-dry-checker -> build/acceptance/dry/*.json       (report only)
  -> entrypoint generator   -> acceptance/generated/*.spec.ts    (Playwright specs)
  -> playwright test runner
```

Acceptance mutation reruns the generated tests against mutated example values
to check the tests actually fail when the examples change.

## Portable tools

The three portable tools (`gherkin-parser`, `gherkin-ir-dry-checker`,
`gherkin-mutator`) are vendored as **Go source** under [tools/go](tools/go)
(zero external dependencies, pinned commit in [tools/UPSTREAM](tools/UPSTREAM)).

CI runs on Linux and dev on macOS, so binaries are **not** committed. Build them
for the current platform (output is gitignored under `build/acceptance/bin/`):

```sh
sh acceptance/tools/build.sh
```

## Layout

- `tools/go/` — vendored portable tool source (committed).
- `tools/build.sh` — builds the tools for the current platform.
- `bin/` — project entrypoint generator + runner adapter (project-specific).
- `src/` — acceptance runtime + step handlers (project-specific).
- `generated/` — generated Playwright specs (derived from IR).
- `features/` (repo root) — Gherkin feature files.
- `build/acceptance/` — IR, dry reports, built binaries (gitignored).

## Running the gate

```sh
pnpm acceptance:visual              # parse -> generate -> run (functional + visual)
pnpm acceptance:visual:capture      # (re)capture baselines for the current platform
pnpm acceptance:mutation:visual     # mutate example values to measure test strength
```

`acceptance:visual` builds the frontend, starts a hot `vite preview` on
`:4173`, mocks the relay WebSocket (`test/e2e/helpers/ws-mock.ts`), and drives
the live page with Playwright — no OpenCode/relay backend required.

## Visual regions

The `the <region> region visually matches <baseline> at <threshold> percent`
step screenshots one DOM region:

- `composer` — the composer/input area (`#input-area`).
- `model-picker` — the harness instance-rail model-picker popover
  (`#model-picker`); it must be open when the step runs.
- `last-user-message` — the most recent sent user message card in the
  transcript (`#messages .msg-user`, last match).
- `messages` — the real transcript scroll container (`#messages`).
- `layout` — the app layout (`#layout`), including the transcript and composer.

Other region ids resolve to `#<region>` directly.

## Step vocabulary

Steps are matched in `src/stepHandlers.ts`. Alongside the existing
`the conduit app is served with the <name> mockup` and visual-match steps:

- `the viewport is a phone` sets the current scenario to 393x852. Put it before
  the app setup step to load at phone size.
- `I scroll the transcript up by <N> pixels` hovers `#messages` and scrolls
  with the mouse wheel.
- `I scroll the transcript back to the bottom` scrolls that same container
  to its full scroll height.
- `the jump-to-latest control is visible` / `the jump-to-latest control is not visible`
  waits for the sticky transcript button to show or hide.

Scroll steps do not sleep; the following assertion waits for the UI to respond.
The `long-transcript` mockup supplies enough history to scroll on a phone.

## Baselines

Baselines live at `acceptance/visual/baselines/<viewport>/<name>.png` and are
compared with pixelmatch. This is a **local** gate — run it on your machine
before claiming a frontend change is done (see the "Visual Acceptance Gate" in
`AGENTS.md`); it is not run in CI. Recapture with `pnpm acceptance:visual:capture`
and commit the PNGs only after visual review of an intentional UI change.

The run defaults to `desktop` (1440x900); `VIEWPORT=phone` selects `phone`
(393x852), and `VIEWPORT=<width>x<height>` remains supported. Each scenario
starts with the run's default viewport. A phone step changes only that scenario,
with baselines in `acceptance/visual/baselines/phone/`. Scenarios without a
viewport step keep the run default and normally use `baselines/desktop/`.

Baselines are inherently platform-sensitive (fonts, sub-pixel AA). Capture and
compare on the same platform; if contributors run on different OSes, recapture
locally rather than sharing one platform's baselines.

## Acceptance mutation

`acceptance:mutation:visual` mutates Gherkin example values (never source),
reruns the generated tests through a persistent NDJSON runner-worker
(`acceptance/bin/acceptance-runner-worker.ts`), and reports killed/survived
mutations. It is a slower quality workflow, not part of the fast gate. Surviving
mutations that are semantically equivalent (e.g. text tweaks that don't cross a
behavioral boundary) are expected.

See `docs/plans/2026-07-12-ubm-acceptance-pipeline/PLAN.md` for the full design.
