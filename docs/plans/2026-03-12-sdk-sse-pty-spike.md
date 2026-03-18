# SDK SSE & PTY Investigation Spike

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Determine whether the SDK's `event.subscribe()` and `pty.connect()` can replace our custom `SSEConsumer` and `pty-upstream.ts`, or whether we should keep those custom implementations alongside the SDK client.

**Architecture:** Write isolated test scripts that exercise the SDK's SSE and PTY features against a live OpenCode instance. Document behavior around reconnection, event format, lifecycle events, and WebSocket semantics. Produce a written recommendation.

**Tech Stack:** TypeScript, `@opencode-ai/sdk`, tsx (for running scripts)

**Prerequisite:** `@opencode-ai/sdk` installed (Task 1 of the main migration plan).

---

### Task 1: Explore SDK SSE (`event.subscribe()`)

**Goal:** Understand what `event.subscribe()` returns, how the stream behaves, and whether it can replace our `SSEConsumer`.

**Files:**
- Create: `spike/sdk-sse-test.ts` (temporary, delete after spike)

**Step 1: Write the SSE test script**

```typescript
// spike/sdk-sse-test.ts
import { createOpencodeClient } from "@opencode-ai/sdk";

const password = process.env["OPENCODE_SERVER_PASSWORD"];
if (!password) {
    console.error("Set OPENCODE_SERVER_PASSWORD");
    process.exit(1);
}

// Question 1: Does createOpencodeClient support auth at all?
// If not, we need custom fetch — same as the main migration.
const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    // Try: fetch with auth header
    fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set(
            "Authorization",
            `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        );
        return globalThis.fetch(input, { ...init, headers });
    },
});

async function testSSE() {
    console.log("--- SSE Test ---");
    console.log("Subscribing to events...");

    try {
        const events = await client.event.subscribe();

        console.log("subscribe() returned:", typeof events);
        console.log("Has .stream?", "stream" in events);
        console.log("Return value keys:", Object.keys(events));

        // Question 2: What is the type/shape of the returned object?
        // The SDK docs show:
        //   const events = await client.event.subscribe()
        //   for await (const event of events.stream) { ... }
        //
        // But what properties does `events` have beyond .stream?
        // Is there a .close() or .abort() method?
        // Is there an .on("error") or .on("reconnect")?

        let count = 0;
        const maxEvents = 10;
        const timeout = setTimeout(() => {
            console.log(`\nTimeout reached after collecting ${count} events`);
            process.exit(0);
        }, 30_000);

        for await (const event of events.stream) {
            count++;
            console.log(`\nEvent #${count}:`);
            console.log("  typeof:", typeof event);
            console.log("  keys:", Object.keys(event));

            // Question 3: What is the event shape?
            // Does it match our OpenCodeEvent { type, properties }?
            // Or is it the GlobalEvent { directory, payload: { type, properties } }?
            // Or something else entirely?
            if ("type" in event) console.log("  type:", event.type);
            if ("properties" in event) {
                console.log("  properties keys:", Object.keys(event.properties as object));
            }
            if ("directory" in event) console.log("  directory:", event.directory);
            if ("payload" in event) console.log("  payload:", event.payload);
            console.log("  raw:", JSON.stringify(event).slice(0, 200));

            if (count >= maxEvents) {
                console.log(`\nCollected ${maxEvents} events, stopping.`);
                clearTimeout(timeout);
                break;
            }
        }
    } catch (err) {
        console.error("SSE error:", err);
    }
}

testSSE();
```

**Step 2: Run the test**

Ensure OpenCode is running on port 4096, then:

```bash
pnpm tsx spike/sdk-sse-test.ts
```

While the script runs, trigger events by sending a message in another terminal or the TUI.

**Step 3: Document the findings**

Record answers to these questions:

| # | Question | Answer |
|---|---|---|
| 1 | What does `event.subscribe()` return? (object shape, methods) | |
| 2 | What does each event in the stream look like? (`{ type, properties }` or `{ directory, payload }`?) | |
| 3 | Does the stream auto-reconnect on disconnect? | |
| 4 | Is there a way to detect connection/disconnection events? | |
| 5 | Can we abort/close the stream programmatically? | |
| 6 | Does it handle heartbeat events? | |
| 7 | What happens when the OpenCode server restarts? | |

---

### Task 2: Test SSE Reconnection Behavior

**Goal:** Determine whether the SDK's SSE stream handles reconnection or if we need our custom backoff logic.

**Files:**
- Create: `spike/sdk-sse-reconnect-test.ts`

**Step 1: Write the reconnection test**

```typescript
// spike/sdk-sse-reconnect-test.ts
import { createOpencodeClient } from "@opencode-ai/sdk";

const password = process.env["OPENCODE_SERVER_PASSWORD"];
const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (password) {
            headers.set("Authorization", `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
        }
        return globalThis.fetch(input, { ...init, headers });
    },
});

async function testReconnection() {
    console.log("--- SSE Reconnection Test ---");
    console.log("1. Subscribe to events");
    console.log("2. Wait for events to flow");
    console.log("3. Kill the OpenCode server");
    console.log("4. Observe: does the stream error, end, or reconnect?");
    console.log("5. Restart the OpenCode server");
    console.log("6. Observe: does it resume?");
    console.log("");

    try {
        const events = await client.event.subscribe();

        let count = 0;
        console.log("Listening for events (kill OpenCode server to test reconnection)...\n");

        for await (const event of events.stream) {
            count++;
            const type = (event as any).type ?? "unknown";
            console.log(`[${new Date().toISOString()}] Event #${count}: ${type}`);
        }

        // If we reach here, the stream ended gracefully
        console.log("\n--- Stream ended (no auto-reconnect) ---");
        console.log("Total events received:", count);
    } catch (err) {
        // If we reach here, the stream threw an error
        console.error("\n--- Stream errored (no auto-reconnect) ---");
        console.error("Error:", err);
    }

    console.log("\nConclusion: SDK SSE stream does NOT auto-reconnect.");
    console.log("We would need to wrap it with our own reconnection logic.");
}

testReconnection();
```

**Step 2: Run the test**

```bash
pnpm tsx spike/sdk-sse-reconnect-test.ts
```

While running:
1. Wait for events to flow
2. Stop the OpenCode server (`kill` or `ctrl+c` the opencode process)
3. Observe: does the script crash, hang, or reconnect?
4. Restart OpenCode
5. Observe: does the stream resume?

**Step 3: Document findings**

| Scenario | Behavior |
|---|---|
| Normal event flow | |
| Server killed while streaming | Stream ends? Throws? Reconnects? |
| Server restarted | Auto-resume? Need manual reconnect? |
| Network timeout | |

---

### Task 3: Compare SSE Event Format

**Goal:** Determine if the SDK normalizes the two SSE formats we handle (global/wrapped vs direct) or if we'd still need our own parsing.

Our `SSEConsumer` handles two formats:
- **Global/wrapped:** `{ directory: string, payload: { type, properties } }`
- **Direct:** `{ type: string, properties: Record<string, unknown> }`

**Files:**
- Modify: `spike/sdk-sse-test.ts` (reuse from Task 1)

**Step 1: Capture events in both formats**

Run with a single project (direct format) and with daemon mode (global format). Compare what `event.subscribe()` yields.

Questions to answer:
- Does the SDK always yield one format?
- Does it strip the `directory` wrapper?
- Do the `type` values match what our `SSEConsumer` emits?
- Are `session.status`, `message.part.updated`, `permission.asked` etc. all present?

**Step 2: Document the mapping**

| Our SSEConsumer event type | SDK event type | Same? |
|---|---|---|
| `message.part.updated` | | |
| `message.part.delta` | | |
| `session.status` | | |
| `permission.asked` | | |
| `question.asked` | | |
| `pty.created` | | |
| `server.heartbeat` | | |

---

### Task 4: Explore SDK PTY Connect

**Goal:** Determine if `pty.connect()` gives us a usable bidirectional stream that could replace our raw `ws` WebSocket connection.

**Files:**
- Create: `spike/sdk-pty-test.ts`

**Step 1: Write the PTY test script**

```typescript
// spike/sdk-pty-test.ts
import { createOpencodeClient } from "@opencode-ai/sdk";

const password = process.env["OPENCODE_SERVER_PASSWORD"];
const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (password) {
            headers.set("Authorization", `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
        }
        return globalThis.fetch(input, { ...init, headers });
    },
});

async function testPty() {
    console.log("--- PTY Test ---");

    // Step 1: Create a PTY session
    console.log("Creating PTY...");
    const createResult = await client.pty.create();
    console.log("Create result:", JSON.stringify(createResult, null, 2));

    const ptyId = (createResult as any).data?.id;
    if (!ptyId) {
        console.error("No PTY ID returned");
        process.exit(1);
    }
    console.log("PTY ID:", ptyId);

    // Step 2: Try pty.connect()
    console.log("\nAttempting pty.connect()...");
    try {
        const connection = await client.pty.connect({ path: { id: ptyId } });
        console.log("connect() returned:", typeof connection);
        console.log("Keys:", Object.keys(connection));
        console.log("Full value:", JSON.stringify(connection, null, 2).slice(0, 500));

        // Question: Is this a WebSocket? A ReadableStream? An HTTP response?
        // The SDK maps GET /pty/{id}/connect — but WebSocket upgrades are
        // typically not handled by HTTP clients.

        // If it's a stream:
        if (connection && typeof (connection as any).stream !== "undefined") {
            console.log("Has .stream — iterating...");
            for await (const chunk of (connection as any).stream) {
                console.log("PTY chunk:", chunk);
            }
        }
    } catch (err) {
        console.error("pty.connect() error:", err);
        console.log("\nThis likely means the SDK's GET-based client cannot handle");
        console.log("the WebSocket upgrade that /pty/{id}/connect requires.");
        console.log("We should keep our custom ws-based pty-upstream.ts.");
    }

    // Cleanup
    console.log("\nDeleting PTY...");
    await client.pty.remove({ path: { id: ptyId } });
    console.log("Done.");
}

testPty();
```

**Step 2: Run the test**

```bash
pnpm tsx spike/sdk-pty-test.ts
```

**Step 3: Document findings**

| # | Question | Answer |
|---|---|---|
| 1 | Does `pty.connect()` succeed or error? | |
| 2 | If it succeeds, what does it return? | |
| 3 | Can we write data TO the PTY through it? | |
| 4 | Can we read terminal output FROM it? | |
| 5 | Does it handle binary cursor metadata (`0x00` prefix)? | |
| 6 | Conclusion: can it replace `pty-upstream.ts`? | |

**Expected outcome:** `pty.connect()` likely fails or returns an unusable response because the SDK's HTTP client (`hey-api`) cannot perform WebSocket upgrades. The `GET /pty/{id}/connect` endpoint expects a WebSocket upgrade handshake that a standard `fetch()`-based client can't do. We'll almost certainly keep our custom `pty-upstream.ts`.

---

### Task 5: Write Recommendation Document

**Files:**
- Create: `spike/sdk-sse-pty-findings.md` (temporary, move to `docs/plans/` if useful)

**Step 1: Summarize all findings**

Write a recommendation document with this structure:

```markdown
# SDK SSE & PTY Spike Findings

## SSE (`event.subscribe()`)

### What it does
[Description of return type, event format, etc.]

### Reconnection behavior
[Does it reconnect? Backoff? Lifecycle events?]

### Event format
[Does it normalize? Which format does it yield?]

### Recommendation
[ADOPT / WRAP / KEEP CUSTOM]

If ADOPT: Use event.subscribe() directly, our SSEConsumer can be deleted.
If WRAP: Use event.subscribe() as transport, wrap with our reconnection/lifecycle logic.
If KEEP CUSTOM: The SDK SSE doesn't meet our needs, keep SSEConsumer as-is.

## PTY (`pty.connect()`)

### What it does
[Description]

### Recommendation
[ADOPT / KEEP CUSTOM]

Expected: KEEP CUSTOM — WebSocket upgrade not supported by fetch-based client.

## Impact on Migration Plan
[Any new tasks to add to the main plan based on findings]
```

**Step 2: Decide and communicate**

Based on findings:

- **If SSE = ADOPT:** Add tasks to the main migration plan to delete `sse-consumer.ts` and wire `event.subscribe()` into `relay-stack.ts`.
- **If SSE = WRAP:** Add tasks to refactor `SSEConsumer` to use `event.subscribe()` as its transport layer instead of raw `fetch`.
- **If SSE = KEEP CUSTOM:** No changes to the main plan. SSEConsumer stays.
- **PTY = KEEP CUSTOM** (expected): No changes. `pty-upstream.ts` stays.

---

### Task 6: Clean Up Spike Files

**Files:**
- Delete: `spike/` directory

**Step 1: Remove temporary files**

```bash
rm -rf spike/
```

Move the findings document to `docs/plans/` if the team wants to preserve it:

```bash
mv spike/sdk-sse-pty-findings.md docs/plans/2026-03-12-sdk-sse-pty-findings.md
```

**Step 2: Commit**

```bash
git add -A
git commit -m "docs: add SDK SSE/PTY spike findings"
```
