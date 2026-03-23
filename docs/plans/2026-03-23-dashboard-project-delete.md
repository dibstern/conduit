# Dashboard Project Delete Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Add project deletion to the Dashboard page via a REST endpoint, with a confirmation modal.

**Architecture:** New `DELETE /api/projects/:slug` REST endpoint in the HTTP router, wired to the daemon's existing `removeProject()` method. Move `ConfirmModal` from `ChatLayout` to `App.svelte` so it's available on all pages. Add a `...` context menu with "Remove" to each project card on the Dashboard.

**Tech Stack:** TypeScript, Svelte 5, Node.js HTTP

**Worktree:** `.worktrees/dashboard-delete` (branch `feat/dashboard-delete`)

---

### Task 1: Add `DELETE /api/projects/:slug` REST endpoint

**Files:**
- Modify: `src/lib/server/http-router.ts` (add to `RequestRouterDeps`, class fields, route handler)
- Modify: `src/lib/daemon/daemon.ts` (wire `removeProject` into router constructor)
- Test: `test/unit/handlers/project-delete-rest.test.ts`

**Step 1: Write the failing test**

Create `test/unit/handlers/project-delete-rest.test.ts`. Since the REST endpoint is handled by `RequestRouter` which is tightly coupled to HTTP, write an integration-style test that sends a real HTTP request to a test server. OR, test at the daemon level by calling the route handler. For simplicity, test via the daemon's E2E or by mocking the HTTP request/response.

Actually, the cleanest approach: test the daemon's REST API via `fetch` against a running daemon. But that's heavy. Instead, add a unit test in the daemon test file that verifies the wiring:

In `test/unit/daemon/daemon.test.ts`, add after the existing "removeProject" tests:

```typescript
it("DELETE /api/projects/:slug removes a project via REST", async () => {
    const d = new Daemon(daemonOpts(tmpDir));
    await d.start();

    const project = await d.addProject("/home/user/rest-delete-test");
    expect(d.getProjects()).toHaveLength(1);

    // Make HTTP request to the daemon's REST API
    const port = d.getPort();
    const res = await fetch(`http://localhost:${port}/api/projects/${project.slug}`, {
        method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Project should be removed
    expect(d.getProjects()).toHaveLength(0);

    await d.stop();
});

it("DELETE /api/projects/:slug returns 404 for unknown slug", async () => {
    const d = new Daemon(daemonOpts(tmpDir));
    await d.start();

    const port = d.getPort();
    const res = await fetch(`http://localhost:${port}/api/projects/nonexistent`, {
        method: "DELETE",
    });
    expect(res.status).toBe(404);

    await d.stop();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon.test.ts -t "DELETE /api/projects"`
Expected: FAIL — 404 because the endpoint doesn't exist yet

**Step 3: Add `removeProject` to `RequestRouterDeps` and `RequestRouter`**

In `src/lib/server/http-router.ts`:

1. Add to `RequestRouterDeps` interface (after `getProjects` on line 74):
```typescript
    /** Remove a project by slug (optional — daemon mode only). */
    removeProject?: (slug: string) => Promise<void>;
```

2. Add private field to `RequestRouter` class (after `getProjects` field around line 114):
```typescript
    private readonly removeProject?: (slug: string) => Promise<void>;
```

3. Assign in constructor (after line 127):
```typescript
    if (deps.removeProject) this.removeProject = deps.removeProject;
```

4. Add `DELETE /api/projects/:slug` route handler after the `GET /api/projects` handler (after line 321):
```typescript
            // ─── Delete project API ────────────────────────────────────
            const deleteMatch =
                pathname.match(/^\/api\/projects\/([^/]+)$/) ??
                undefined;
            if (deleteMatch && req.method === "DELETE") {
                const slug = decodeURIComponent(deleteMatch[1]!);
                if (!this.removeProject) {
                    res.writeHead(501, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Not supported" }));
                    return;
                }
                try {
                    await this.removeProject(slug);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            error:
                                err instanceof Error
                                    ? err.message
                                    : "Unknown error",
                        }),
                    );
                }
                return;
            }
```

**Step 4: Wire `removeProject` in daemon.ts**

In `src/lib/daemon/daemon.ts`, in the `RequestRouter` constructor call (around line 557), add after `getProjects`:

```typescript
            removeProject: (slug) => this.removeProject(slug),
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/daemon.test.ts -t "DELETE /api/projects"`
Expected: PASS

**Step 6: Run full verification**

Run: `pnpm check && pnpm test:unit`
Expected: All pass

**Step 7: Commit**

```bash
git add src/lib/server/http-router.ts src/lib/daemon/daemon.ts test/unit/daemon/daemon.test.ts
git commit -m "feat: add DELETE /api/projects/:slug REST endpoint"
```

---

### Task 2: Move ConfirmModal to App.svelte

**Files:**
- Modify: `src/lib/frontend/App.svelte` (add ConfirmModal import and render)
- Modify: `src/lib/frontend/components/layout/ChatLayout.svelte` (remove ConfirmModal)

**Step 1: Move ConfirmModal from ChatLayout to App**

In `src/lib/frontend/App.svelte`, add import and render:

```svelte
<script lang="ts">
    import { getCurrentRoute } from "./stores/router.svelte.js";
    import ChatLayout from "./components/layout/ChatLayout.svelte";
    import PinPage from "./pages/PinPage.svelte";
    import DashboardPage from "./pages/DashboardPage.svelte";
    import SetupPage from "./pages/SetupPage.svelte";
    import ConfirmModal from "./components/overlays/ConfirmModal.svelte";

    const route = $derived(getCurrentRoute());
</script>

{#if route.page === "chat"}
    <ChatLayout />
{:else if route.page === "dashboard"}
    <DashboardPage />
{:else if route.page === "auth"}
    <PinPage />
{:else if route.page === "setup"}
    <SetupPage />
{/if}

<ConfirmModal />
```

In `src/lib/frontend/components/layout/ChatLayout.svelte`:
- Remove the `import ConfirmModal` line (line 15)
- Remove the `<ConfirmModal />` render (line 597)

**Step 2: Run verification**

Run: `pnpm check`
Expected: All pass. The existing E2E tests for project delete (which use `confirm()` in the ProjectSwitcher) should still work since `ConfirmModal` is now rendered at a higher level.

**Step 3: Commit**

```bash
git add src/lib/frontend/App.svelte src/lib/frontend/components/layout/ChatLayout.svelte
git commit -m "refactor: move ConfirmModal to App.svelte for global availability"
```

---

### Task 3: Add delete button and flow to DashboardPage

**Files:**
- Modify: `src/lib/frontend/pages/DashboardPage.svelte`

**Step 1: Add imports, state, and delete handler**

In `src/lib/frontend/pages/DashboardPage.svelte`, add imports:

```typescript
import ProjectContextMenu from "../components/project/ProjectContextMenu.svelte";
import Icon from "../components/shared/Icon.svelte";
import { confirm } from "../stores/ui.svelte.js";
```

Add state and handlers:

```typescript
import type { DashboardProject } from "./dashboard-types.js";

// ─── Context menu state ───────────────────────────────────────────────────
let ctxMenuProject: DashboardProject | null = $state(null);
let ctxMenuAnchor: HTMLElement | null = $state(null);

function handleProjectContextMenu(project: DashboardProject, anchor: HTMLElement) {
    ctxMenuProject = project;
    ctxMenuAnchor = anchor;
}

function handleCloseContextMenu() {
    ctxMenuProject = null;
    ctxMenuAnchor = null;
}

async function handleCtxDelete(slug: string, title: string) {
    const confirmed = await confirm(
        `Remove project '${title}' from conduit?`,
        "Remove",
    );
    if (!confirmed) return;
    try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}`, {
            method: "DELETE",
        });
        if (res.ok) {
            await fetchProjects();
        }
    } catch {
        // Deletion failed — project list will refresh on next poll
    }
}
```

**Step 2: Add `...` button to each project card**

In the `{#each projects as project}` loop, add a `...` button inside each card. Add it inside the card header `<div>`, after the status icon:

```svelte
<button
    class="shrink-0 w-6 h-6 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center text-text-dimmer opacity-0 group-hover:opacity-100 hover:text-text hover:bg-bg-surface transition-[opacity,color] duration-100"
    title="More options"
    onclick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleProjectContextMenu(project, e.currentTarget as HTMLElement);
    }}
>
    <Icon name="ellipsis" size={15} />
</button>
```

**Step 3: Render the context menu**

At the bottom of the template, add:

```svelte
{#if ctxMenuProject && ctxMenuAnchor}
    <ProjectContextMenu
        project={{ slug: ctxMenuProject.slug, title: ctxMenuProject.title, directory: ctxMenuProject.path }}
        anchor={ctxMenuAnchor}
        onrename={() => {}}
        ondelete={handleCtxDelete}
        onclose={handleCloseContextMenu}
    />
{/if}
```

Note: `onrename` is a no-op for now since we're only implementing delete. The context menu will still show "Rename" but it won't do anything. If this is undesirable, create a Dashboard-specific context menu or make the rename button conditional.

**Step 4: Run verification**

Run: `pnpm check && pnpm build:frontend`
Expected: All pass

**Step 5: Commit**

```bash
git add src/lib/frontend/pages/DashboardPage.svelte
git commit -m "feat: add project delete to Dashboard via REST and context menu"
```

---

### Task 4: E2E Test for Dashboard Deletion

**Files:**
- Create: `test/e2e/specs/dashboard-delete.spec.ts`
- Create: `test/e2e/playwright-dashboard-delete.config.ts`

**Step 1: Create Playwright config**

Create `test/e2e/playwright-dashboard-delete.config.ts` modeled after the existing project-management config but targeting the dashboard page.

**Step 2: Write E2E test**

The Dashboard doesn't use WS mocks — it uses real REST endpoints. For E2E testing the Dashboard's project delete, we need the daemon running. Use the `daemon` E2E test pattern which starts a real daemon.

Alternatively, mock the REST endpoint with `page.route()` intercepting `DELETE /api/projects/:slug`.

Write tests covering:
- Clicking `...` shows context menu with "Remove"
- Clicking "Remove" shows confirmation modal
- Confirming sends DELETE request and project disappears
- Cancelling does not send DELETE request

**Step 3: Run E2E tests**

Run: `npx playwright test --config test/e2e/playwright-dashboard-delete.config.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add test/e2e/specs/dashboard-delete.spec.ts test/e2e/playwright-dashboard-delete.config.ts
git commit -m "test: add E2E tests for Dashboard project deletion"
```

---

### Task 5: Final Verification

**Step 1: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Step 2: Run existing project management E2E tests (regression)**

Run: `pnpm test:project-management`
Expected: All 20 tests pass — moving ConfirmModal to App.svelte shouldn't break anything
