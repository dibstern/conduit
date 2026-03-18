# Multi-Instance Playwright E2E Tests — Design

## Problem

The multi-instance feature has ~3,650 lines of Vitest unit/integration tests covering the backend (InstanceManager, IPC, config persistence, WS wiring, store logic). There are zero Playwright E2E tests for any multi-instance UI feature. All tests pass despite several planned UI features not being built yet.

## Goal

Write Playwright tests for ALL multi-instance features defined in the multi-instance plan. Tests for implemented features validate real behavior. Tests for deferred features fail immediately, providing a TDD checklist for completing the plan.

## Approach: Hybrid (WS-Mock + Real Daemon Smoke)

**Primary:** WS-mock tests using the existing `ws-mock.ts` + `vite preview` infrastructure. Inject `instance_list` / `instance_status` messages, assert UI reactions. Fast, deterministic, CI-friendly.

**Secondary:** One smoke test against a real daemon with multiple instances to verify the full stack.

## File Layout

```
test/e2e/
  fixtures/
    mockup-state.ts          # ADD: multi-instance fixtures
  specs/
    multi-instance.spec.ts   # NEW: all multi-instance tests
```

## Config

Uses the `playwright-visual.config.ts` pattern (Vite preview, WS mock) with a dedicated config or extending the existing one. Two viewport projects: desktop (1440x900) + mobile (393x852, iPhone 15).

## Fixtures

### `multiInstanceInit` — Two instances, projects bound to each

```ts
// Added to mockup-state.ts
export const multiInstanceMessages: MockMessage[] = [
  {
    type: "instance_list",
    instances: [
      { id: "personal", name: "Personal", port: 4096, managed: true, status: "healthy", restartCount: 0, createdAt: Date.now() - 86400_000 },
      { id: "work", name: "Work", port: 4097, managed: true, status: "unhealthy", restartCount: 2, createdAt: Date.now() - 43200_000 },
    ],
  },
];

export const singleInstanceMessages: MockMessage[] = [
  {
    type: "instance_list",
    instances: [
      { id: "default", name: "Default", port: 4096, managed: true, status: "healthy", restartCount: 0, createdAt: Date.now() },
    ],
  },
];
```

### Project list with `instanceId` bindings

```ts
export const multiInstanceProjects = {
  type: "project_list",
  projects: [
    { slug: "myapp", title: "myapp", directory: "/src/myapp", instanceId: "personal" },
    { slug: "mylib", title: "mylib", directory: "/src/mylib", instanceId: "personal" },
    { slug: "company-api", title: "company-api", directory: "/src/company-api", instanceId: "work" },
  ],
};
```

## Test Groups

### Group 1: ProjectSwitcher Instance Grouping (IMPLEMENTED)

| Test | Assertion |
|------|-----------|
| groups projects by instance when multiple instances exist | Instance group headers with status dots visible in ProjectSwitcher |
| shows flat list when single instance | No group headers, flat project list |
| shows instance status color in group header | green dot for healthy, red for unhealthy |
| updates grouping when instance_status changes | Send status update, verify dot color changes live |

### Group 2: Header Instance Badge (IMPLEMENTED)

| Test | Assertion |
|------|-----------|
| shows instance badge when multiple instances exist | Badge visible next to project name |
| hides instance badge with single instance | No badge rendered |
| badge shows correct instance name and status color | Text = instance name, dot = status color |
| badge updates on instance_status message | Send status change, verify color transitions |

### Group 3: ConnectOverlay Instance Name (IMPLEMENTED)

| Test | Assertion |
|------|-----------|
| shows instance name in connecting message | "Connecting to {instanceName}..." visible |
| falls back to 'OpenCode' with no instance binding | "Connecting to OpenCode..." visible |

### Group 4: Instance Store Reactivity (IMPLEMENTED)

| Test | Assertion |
|------|-----------|
| instance_list message populates UI | Instances appear in ProjectSwitcher and Header |
| instance_status updates single instance | Only affected instance changes status |
| store clears on WS disconnect | Instance UI elements disappear |

### Group 5: Status Color Mapping (IMPLEMENTED)

| Test | Assertion |
|------|-----------|
| healthy=green, starting=yellow, unhealthy=red, stopped=gray | CSS classes match expected Tailwind colors |

### Group 6: Instance Selector Dropdown (DEFERRED — tests will fail)

| Test | Assertion |
|------|-----------|
| clicking header badge opens instance selector dropdown | Dropdown appears with instance list |
| dropdown lists all instances with health status | Each instance shows name + status dot |
| selecting instance switches to its projects | Project list filters to selected instance |
| 'Manage Instances' link at bottom | Link visible, navigates to settings |

### Group 7: Instance Management Settings Panel (DEFERRED — tests will fail)

| Test | Assertion |
|------|-----------|
| gear icon opens settings with Instances tab | Settings panel visible with Instances tab |
| instances tab lists all instances | Each shows status, port, project count |
| 'Add Instance' button shows inline form | Form appears with name, port/URL, env fields |
| add managed instance via form | WS sends instance_add with correct payload |
| add external instance via form | WS sends instance_add with URL |
| instance expand shows start/stop/remove | Buttons visible on expand |
| start sends instance_start | WS message verified |
| stop sends instance_stop | WS message verified |
| remove shows confirmation then sends instance_remove | Dialog then WS message |

### Group 8: ConnectOverlay Instance Actions (DEFERRED — tests will fail)

| Test | Assertion |
|------|-----------|
| 'Start Instance' button when instance is down | Button visible in overlay |
| 'Switch Instance' button when instance is down | Button visible in overlay |

### Group 9: Project-Instance Binding UI (DEFERRED — tests will fail)

| Test | Assertion |
|------|-----------|
| add project form includes instance selector | Dropdown present in add-project form |
| defaults to first healthy instance | Dropdown pre-selects healthy instance |

### Group 10: Dashboard Instance Status (DEFERRED — tests will fail)

| Test | Assertion |
|------|-----------|
| banner when no healthy instances | "No healthy OpenCode instances" banner visible |
| 'Manage Instances' link in banner | Link visible and clickable |

### Group 11: Real Daemon Smoke Test

| Test | Assertion |
|------|-----------|
| daemon with instances sends instance_list on connect | Browser receives instance_list, UI renders instances |

## Implementation Notes

- Deferred tests should be tagged with `test.fail()` or `test.fixme()` so the suite passes in CI while clearly marking what needs building
- WS mock needs minor extension: support `project_list` messages with `instanceId` fields (currently `mockup-state.ts` doesn't include `instanceId` on projects)
- The ConnectOverlay tests need a way to simulate disconnect — either close the mock WS or never send init messages
- Real daemon smoke test needs its own fixture that starts a daemon with the InstanceManager configured with 2 instances (can use the existing `E2EHarness` pattern but with instance configuration)
