**Task 5: TLS Certificate Loading as a Layer -- Audit Report (Re-audit)**

**Summary:** Amendments AP-12 through AP-17 address the original audit findings well, but introduce two new issues: (1) AP-13 adds `caCertPem` to the interface but the success-path return statement is never updated to include it, causing a compile error; and (2) AP-17 specifies `EnsureCertsTag` DI for tests but the implementation calls `ensureCerts` directly -- making the mock tag ineffective. Both require plan amendments.

**Findings:**

| # | Category | Action | Issue | File:Line | Amendment / Question |
|---|----------|--------|-------|-----------|----------------------|
| 1 | Incorrect Code | Amend Plan | AP-13 adds `caCertPem: Buffer \| null` to `TlsCertService` interface but does not update the success-path return object (plan lines 659-663). That return has `certs`, `caRootPath`, `caCertDer` but no `caCertPem`. AP-15's early-return does include `caCertPem: null`, so only the success path is missing. This will cause a TypeScript compile error since the interface requires the field. | plan:659-663, plan:1306 | Add `caCertPem: certs?.caCertPem ?? null` to the success-path return object alongside the existing `caCertDer` line. |
| 2 | Incorrect Code | Amend Plan | AP-17 says to use `EnsureCertsTag` service for DI in tests, but the `TlsCertLive` implementation (plan lines 639-650) calls `ensureCerts` directly via import, not through a Context Tag. Tests providing a mock via `EnsureCertsTag` would have no effect on the actual implementation code path. | plan:639, plan:1321 | Either (a) add an `EnsureCertsTag` Context.Tag to `tls-cert-layer.ts` and make `TlsCertLive` resolve it from context instead of importing `ensureCerts` directly, or (b) change AP-17 to use `vi.mock("../cli/tls.js")` instead. Option (a) is more Effect-idiomatic and consistent with AP-17's stated intent. |
| 3 | Implicit Assumptions | Accept | AP-12 checks `if (certs && !config.hostExplicit)` but after AP-15's early return on `!certs`, `certs` is guaranteed truthy at this point. The `certs &&` guard is dead code -- redundant but harmless. | plan:1300, plan:1311-1316 | -- |
| 4 | Implicit Assumptions | Accept | `TlsCertService` duplicates fields from `TlsCerts` (`caRootPath`, `caCertDer`, `caCertPem`) already accessible via `certs.caRoot`, `certs.caCertDer`, `certs.caCertPem`. Convenience pattern, not a bug. | plan:613-617, src/lib/cli/tls.ts:17-25 | -- |
| 5 | Implicit Assumptions | Accept | The imperative code (daemon-main.ts:1075-1082) performs cert chain concatenation (`Buffer.concat([cert, "\n", caCertPem])`) before passing to the HTTP server. Task 5 does not replicate this -- it defers to the HTTP server layer. AP-13 acknowledges this ("HTTP server layer needs it for cert chain"). Downstream task must handle concatenation. | src/lib/effect/daemon-main.ts:1076-1080, plan:1306 | -- |
| 6 | State Issues | Accept | `config` is read from `Ref.get(configRef)` once at line 633, then `hostExplicit` is checked from that snapshot at AP-12. Intermediate `Ref.update` calls (AP-15) mutate `tlsEnabled` but not `hostExplicit`, so the stale snapshot is safe for this specific field. | plan:633, plan:1300 | -- |

**No issues found in:** Insufficient Test Coverage (AP-17's 5 test cases cover the right paths, assuming finding #2 is resolved to make them functional).

**Key source files examined:**
- `/Users/dstern/src/personal/conduit/src/lib/cli/tls.ts` -- `ensureCerts` returns `Promise<TlsCerts | null>` (line 223); `TlsCerts` has `key`, `cert`, `caRoot`, `caCertPem`, `caCertDer` (lines 17-25)
- `/Users/dstern/src/personal/conduit/src/lib/effect/daemon-config.ts` -- `DaemonEnvConfig` with `hostExplicit: boolean` (line 20)
- `/Users/dstern/src/personal/conduit/src/lib/effect/daemon-main.ts:1055-1082` -- imperative TLS block being replaced
- `/Users/dstern/src/personal/conduit/docs/plans/2026-05-07-daemon-effect-phase8-plan.md` -- Task 5 (lines 596-675), amendments (lines 1296-1322), Task 1 `DaemonRuntimeConfig` (lines 156-196, 1205-1218)
