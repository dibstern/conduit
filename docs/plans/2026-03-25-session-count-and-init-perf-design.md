# Session Count Accuracy & Initialize Performance Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs: (1) `SessionManager.initialize()` hammers OpenCode with hundreds of message fetches, blocking relay startup for 10-30s; (2) session counts are wrong because the `/session` API is project-scoped but the relay doesn't pass project context.

**Architecture:** Replace the message-fetching loop in `initialize()` with session metadata timestamps. Pass `directory` to `OpenCodeClient` unconditionally so the `x-opencode-directory` header scopes all requests to the correct project.

**Tech Stack:** TypeScript, Node.js fetch API, OpenCode REST API

---

### Task 1: Fix `initialize()` — use session timestamps instead of message fetches

**Files:**
- Modify: `src/lib/session/session-manager.ts:276-304`
- Test: `test/unit/session/session-manager.test.ts` (existing)

**Step 1: Write the failing test**

Add a test that verifies `initialize()` does NOT call `getMessages`:

```typescript
it("initialize seeds lastMessageAt from session time.updated without fetching messages", async () => {
  const mockClient = {
    listSessions: vi.fn().mockResolvedValue([
      { id: "ses_1", time: { created: 1000, updated: 2000 } },
      { id: "ses_2", time: { created: 500, updated: 1500 } },
    ]),
    getMessages: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ id: "ses_1" }),
  };
  // ... construct SessionManager with mockClient
  await mgr.initialize();
  expect(mockClient.getMessages).not.toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-manager.test.ts -t "seeds lastMessageAt"`
Expected: FAIL — `getMessages` IS called (current behavior)

**Step 3: Implement the fix**

In `src/lib/session/session-manager.ts:280-304`, replace:

```typescript
if (existing.length > 0) {
    // Seed lastMessageAt from actual message timestamps.
    // Fetch messages for each session in parallel.
    await Promise.all(
        existing.map(async (s) => {
            try {
                const msgs = await this.client.getMessages(s.id);
                if (msgs.length > 0) {
                    let latest = 0;
                    for (const m of msgs) {
                        const ts = m.time?.completed ?? m.time?.created ?? 0;
                        if (ts > latest) latest = ts;
                    }
                    if (latest > 0) {
                        this.lastMessageAt.set(s.id, latest);
                    }
                }
            } catch (err) {
                this.log.warn(
                    `Failed to fetch messages for ${s.id.slice(0, 12)} during init: ${err instanceof Error ? err.message : err}`,
                );
            }
        }),
    );
```

With:

```typescript
if (existing.length > 0) {
    // Seed lastMessageAt from session metadata (no message fetches needed).
    // time.updated reflects the latest activity; SSE events refine it later.
    for (const s of existing) {
        const ts = s.time?.updated ?? s.time?.created ?? 0;
        if (ts > 0) this.lastMessageAt.set(s.id, ts);
    }
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-manager.test.ts`
Expected: PASS, all existing tests still pass

**Step 5: Commit**

```bash
git add src/lib/session/session-manager.ts test/unit/session/session-manager.test.ts
git commit -m "perf: use session time.updated instead of fetching messages in initialize()

initialize() was calling getMessages() for every session in parallel,
creating 500+ concurrent HTTP requests that saturated OpenCode and
blocked relay startup for 10-30s. session.time.updated provides the
same ordering data with zero additional API calls."
```

---

### Task 2: Pass project directory to OpenCodeClient unconditionally

**Files:**
- Modify: `src/lib/relay/relay-stack.ts:145-151`
- Test: existing relay/client tests

**Step 1: Write the failing test**

Add a test that verifies the client is constructed with the project directory:

```typescript
it("creates OpenCodeClient with project directory for x-opencode-directory scoping", async () => {
  // ... set up relay config with projectDir: "/home/user/myproject"
  // ... create relay
  // ... verify client sends x-opencode-directory header
});
```

(The exact test depends on how the relay test harness works. May need to mock fetch and verify the header.)

**Step 2: Implement the fix**

In `src/lib/relay/relay-stack.ts:145-151`, change:

```typescript
const client = new OpenCodeClient({
    baseUrl: config.opencodeUrl,
    ...(config.noServer &&
        config.projectDir != null && {
            directory: config.projectDir,
        }),
});
```

To:

```typescript
const client = new OpenCodeClient({
    baseUrl: config.opencodeUrl,
    ...(config.projectDir != null && {
        directory: config.projectDir,
    }),
});
```

Remove the `config.noServer` guard. The client should ALWAYS pass the project directory so OpenCode scopes session operations to the correct project.

**Step 3: Run tests**

Run: `pnpm vitest run test/unit/relay/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/relay/relay-stack.ts
git commit -m "fix: pass project directory to OpenCodeClient unconditionally

The x-opencode-directory header was only set when noServer=true,
meaning daemon-hosted relays never scoped their session requests
to the correct project. This caused session counts to reflect the
server's default project instead of each relay's project."
```

---

### Task 3: Fix daemon prefetch to use per-project directory header

**Files:**
- Modify: `src/lib/daemon/daemon.ts` (`prefetchSessionCounts` method)

**Step 1: Implement the fix**

In `prefetchSessionCounts()`, change the fetch to include the project directory header, and change from grouping by URL to iterating per-project:

```typescript
private prefetchSessionCounts(): void {
    for (const slug of this.registry.slugs()) {
        const entry = this.registry.get(slug);
        if (!entry) continue;
        if (this.persistedSessionCounts.has(slug)) continue;
        const url = this.resolveOpencodeUrl(entry.project.instanceId);
        if (!url) continue;

        const instanceId = entry.project.instanceId ?? "default";
        const instance = this.instanceManager.getInstance(instanceId);
        const password =
            instance?.env?.["OPENCODE_SERVER_PASSWORD"] ??
            process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
        const username =
            instance?.env?.["OPENCODE_SERVER_USERNAME"] ??
            process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";
        const headers: Record<string, string> = {
            "x-opencode-directory": entry.project.directory,
        };
        if (password) {
            headers["Authorization"] =
                `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
        }

        fetch(`${url}/session?limit=10000`, { headers })
            .then((res) => res.json())
            .then((data: unknown) => {
                if (Array.isArray(data)) {
                    this.persistedSessionCounts.set(slug, data.length);
                }
            })
            .catch(() => {});
    }
}
```

**Step 2: Build and test**

Run: `pnpm build && pnpm test:unit`
Expected: Build succeeds, tests pass

**Step 3: Commit**

```bash
git add src/lib/daemon/daemon.ts
git commit -m "fix: pass x-opencode-directory in prefetch for per-project session counts

Each project now gets its own session count fetch scoped to its
directory, instead of one shared fetch that only returned sessions
for the server's default project."
```

---

### Task 4: Verify end-to-end

**Step 1: Build**

```bash
pnpm build
```

**Step 2: Start daemon and verify session counts**

```bash
node dist/src/bin/cli.js --daemon &
sleep 5
# Query list_projects and verify per-project counts
node -e "..."  # (IPC query as used throughout this session)
```

Expected: All projects show correct per-project session counts within 5s.

**Step 3: Verify relay startup is fast**

Check daemon logs: relays should become "ready" within 2-3s, not 10-30s.

```bash
tail -100 ~/.config/conduit/daemon.log | grep "relay ready"
```

**Step 4: Commit any final fixes**
