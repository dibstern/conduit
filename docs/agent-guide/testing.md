# Testing Guide

Use this guide before choosing verification beyond the default path in AGENTS.md.

## Default Verification Path

For most changes, run only the narrow default path:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Start there unless the change crosses a boundary that unit tests cannot cover.

## When To Escalate

### Integration

Run this when changing daemon, relay, server, session, or instance behavior that depends on a real relay stack or OpenCode interaction.

```bash
pnpm test:integration
pnpm test:contract
```

### E2E (Replay — Default)

Run this when changing browser-visible workflows, WebSocket behavior, mobile flows, or end-to-end session lifecycles. Uses recorded WebSocket fixtures — no running OpenCode instance needed.

```bash
pnpm test:e2e                                    # full suite
pnpm test:e2e -- test/e2e/specs/<spec>.ts         # single spec
pnpm test:e2e -- --grep "<name>"                  # by test name
```

Prefer a single spec or grep filter over the full suite.

### Live E2E

Run this for full-pipeline validation against a real, ephemeral OpenCode instance. Requires `opencode` on `$PATH` and valid API credentials.

```bash
pnpm test:e2e:live
```

### Updating Recorded Fixtures

Run this when the WebSocket protocol or server behavior changes and recorded fixtures need refreshing.

```bash
pnpm test:record-snapshots
```

### Daemon E2E

Run this only when changing daemon lifecycle or daemon-specific flows that are covered by the dedicated Playwright config.

```bash
OPENCODE_SERVER_PASSWORD=<password> pnpm test:daemon
```

### Multi-Instance

Run this when changing instance switching, registry behavior, or multi-instance UI and routing.

```bash
pnpm test:multi-instance
```

### Visual Regression

Run this only for deliberate UI or rendering changes where screenshot coverage matters.

```bash
pnpm test:visual
pnpm test:storybook-visual
```

## Selection Heuristics

- Prefer the smallest test surface that proves the change.
- Do not run full E2E or visual suites for pure refactors, docs changes, or isolated backend logic.
- If a change affects both runtime logic and UI, use the default path first, then add the narrowest relevant integration or E2E command.
- If you need alternate modes or helper variants, check `package.json` rather than copying the full script inventory into AGENTS.md.