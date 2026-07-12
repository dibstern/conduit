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

## Baselines

Baselines live at `acceptance/visual/baselines/<viewport>/<name>.png` and are
compared with pixelmatch. This is a **local** gate — run it on your machine
before claiming a frontend change is done (see the "Visual Acceptance Gate" in
`AGENTS.md`); it is not run in CI. Recapture with `pnpm acceptance:visual:capture`
and commit the PNGs only after visual review of an intentional UI change.

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
