# Effect 4 codemod measurements

Run `node scripts/effect4-codemod/measure.mjs`. The harness copies the current v3 sources outside the worktree, installs the pinned v4 dependencies, checks both tsconfigs, and restores the original v3 files before measuring each transform independently. The codemod resolves symbols against the original v3 tree and exports edits without changing it.

Source SHA-256: `3d8a1bbee6046f1f5fbc404f8a2575b94264f86c4206b390a9217eccb70afee8`. TypeScript: `5.9.3`. Node: `v26.10.0`.

Scratch dependencies: `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/opentelemetry`, and `@effect/vitest`, each exactly `4.0.5`. Consolidated `@effect/platform`, `@effect/rpc`, `@effect/sql`, and `@effect/experimental` are removed.

Commands (in the scratch copy):

```sh
pnpm install --no-frozen-lockfile --ignore-scripts
pnpm exec tsc --noEmit --pretty false --project tsconfig.json
pnpm exec tsc --noEmit --pretty false --project src/lib/frontend/tsconfig.json
```

Baseline: **28995 diagnostics** (root and frontend counts include duplicate diagnostics in shared files).

| Transform | Edits | Before | After | Own category before → after | New outside category | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| imports | 41 | 28995 | 28892 | 517 → 476 | 0 | PASS |
| services | 12 | 28995 | 28979 | 256 → 252 | 0 | PASS |
| generators | 3 | 28995 | 28966 | 737 → 732 | 0 | PASS |
| layers | 13 | 28995 | 28982 | 1560 → 1548 | 0 | PASS |
| catch | 22 | 28995 | 28940 | 1053 → 1018 | 0 | PASS |
| either | 408 | 28995 | 28729 | 247 → 225 | 0 | PASS |
| fork | 117 | 28995 | 28843 | 169 → 55 | 0 | PASS |
| option | 1 | 28995 | 28994 | 84 → 83 | 0 | PASS |
| schema | 26 | 28995 | 28985 | 1961 → 1951 | 0 | PASS |
| testing | 285 | 28995 | 28701 | 551 → 269 | 0 | PASS |
| core | 29 | 28995 | 28959 | 4279 → 4248 | 0 | PASS |
| combined | 956 | 28995 | 28007 | 28995 → 28007 | 0 | PASS |

## All diagnostic categories

Each transform column is its after count; every transform starts from the same baseline.

| Category | Baseline | imports | services | generators | layers | catch | either | fork | option | schema | testing | core | combined |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| catch | 1053 | 1053 | 1053 | 1053 | 1053 | 1018 | 1053 | 1053 | 1053 | 1053 | 1053 | 1053 | 1018 |
| core | 4279 | 4274 | 4279 | 4279 | 4279 | 4278 | 4129 | 4270 | 4279 | 4279 | 4276 | 4248 | 4078 |
| either | 247 | 247 | 247 | 247 | 247 | 247 | 225 | 247 | 247 | 247 | 247 | 247 | 225 |
| fork | 169 | 169 | 169 | 169 | 169 | 168 | 169 | 55 | 169 | 169 | 169 | 169 | 51 |
| generators | 737 | 726 | 737 | 732 | 736 | 734 | 725 | 733 | 737 | 737 | 734 | 737 | 692 |
| imports | 517 | 476 | 517 | 517 | 517 | 517 | 517 | 517 | 517 | 517 | 517 | 517 | 476 |
| layers | 1560 | 1560 | 1554 | 1560 | 1548 | 1560 | 1560 | 1560 | 1560 | 1560 | 1560 | 1559 | 1540 |
| option | 84 | 84 | 84 | 84 | 84 | 84 | 84 | 81 | 83 | 84 | 84 | 84 | 80 |
| other | 17581 | 17535 | 17575 | 17557 | 17581 | 17566 | 17499 | 17559 | 17581 | 17581 | 17575 | 17577 | 17375 |
| schema | 1961 | 1961 | 1961 | 1961 | 1961 | 1961 | 1961 | 1961 | 1961 | 1951 | 1961 | 1961 | 1951 |
| services | 256 | 256 | 252 | 256 | 256 | 256 | 256 | 256 | 256 | 256 | 256 | 256 | 252 |
| testing | 551 | 551 | 551 | 551 | 551 | 551 | 551 | 551 | 551 | 551 | 269 | 551 | 269 |

The JSON artifact contains total, TS diagnostic-code and API-category counts and category deltas for every run. Categories use the original v3 AST and type-checker-resolved Effect exports at the failing API site, with diagnostic codes/messages as fallback. Callback signatures can belong to their calling API; callback bodies retain their independent categories. Unclassified errors remain `other`. New diagnostics are compared as multisets using file, project, code, complete message, and original source offset (edits are reversed for location matching). A transform passes only when its category decreases, its total decreases, and it introduces no diagnostics outside its category. A transform with no applicable sites is recorded as unmeasured, never as passing.

Raw compiler logs, patches, codemod reports, and introduced-diagnostic details are retained under `test-results/effect4-codemod-measurements/`; the scratch copy is removed unless `--keep-scratch` is supplied. `.svelte` files are not analyzed by `tsc`; the codemod report lists those separately.

## Collision and rerun proof

Run `node scripts/effect4-codemod/self-check.mjs`. [SAFETY.json](SAFETY.json) records the type-checked probe, unchanged local `catchAll`, `Either` and `Literal` symbols, positive aliased Effect rewrites, and source-tree hashes before and after two runs. It requires the second run to produce zero files and zero edits and verifies the original checkout stayed unchanged. The temporary copy is removed automatically.
