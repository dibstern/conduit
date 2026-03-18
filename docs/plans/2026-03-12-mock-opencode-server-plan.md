# Mock OpenCode Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the real OpenCode dependency in integration and E2E tests with a record+replay mock HTTP server so all tests run without a live OpenCode instance.

**Architecture:** A recording proxy captures raw OpenCode HTTP interactions during fixture generation. A mock server replays those interactions using queued responses and SSE event streaming. Both integration tests (raw WS clients) and E2E tests (Playwright browser) run against a real relay backed by the mock.

**Tech Stack:** Node.js `http.createServer`, `ws` (WebSocket library), Vitest, Playwright, existing `RelayStack`

**Design doc:** `docs/plans/2026-03-12-mock-opencode-server-design.md`

---

## Issue Resolutions

These 14 issues were discovered during plan review. Their resolutions are woven into the tasks below.

| # | Issue | Resolution | Tasks affected |
|---|---|---|---|
| 1 | PTY WebSocket upstream — mock needs WS upgrades for `/pty/:id/connect` | Extend interaction types with PTY kinds, recording proxy with WS proxy via `ws`, mock server with WS echo/replay | 1, 2, 3 |
| 2 | Permission SSE batch triggers — `POST /permission/:id/reply` (and other REST calls) must trigger SSE batches, not just `prompt_async` | Split SSE batches at ANY REST call boundary in recording; hold emission until that REST call arrives | 3 |
| 3 | Session ID determinism — tests create sessions with `Date.now()` titles | Rewrite tests to use deterministic, recording-aligned inputs | 6, 9 |
| 4 | SSE reconnection — mock must hold connections with keepalive | Send `: keepalive\n\n` every 15s on SSE connections | 3 |
| 5 | `server.connected` event — must emit immediately on SSE connect | Mock emits `server.connected` as first event when `/event` connects | 3 |
| 6 | Auth headers — mock should ignore auth | Mock does not validate Authorization headers; no action needed | 3 |
| 7 | `waitForTimeout` brittleness — 35 occurrences need replacement | Replace with `waitFor` + DOM assertions during E2E migration | 11 |
| 8 | Dashboard/pin specs — need full init REST responses | Ensure recordings include all init-phase REST calls (`/path`, `/session`, `/agent`, `/provider`, etc.) | 5, 6 |
| 9 | Permission flow complexity — full-stack async flow | Implement permission spec as proof-of-concept before migrating other permission specs | 11 |
| 10 | Test isolation — need `mock.reset()` | Add `reset()` method that re-initializes all queues from the original recording | 3 |
| 11 | Response headers — mock must set `Content-Type: application/json` | Set `Content-Type` for all non-204 responses | 3 |
| 12 | DELETE 204 handling — empty body, no content-type | Return empty body with 204 status and no content-type header | 3 |
| 13 | Status poller queue exhaustion — `GET /session/status` polled every 500ms | OK: relay uses SSE `session.status` when SSE connected; ensure recordings include status transitions; mock returns last queued response when exhausted | 3, 5 |
| 14 | PTY recording proxy — recording proxy needs WS proxy for PTY | Add `ws` dependency, proxy WebSocket upgrades to upstream, capture frames | 2 |

---

### Task 1: Add OpenCodeRecording Type

**Files:**
- Modify: `test/e2e/fixtures/recorded/types.ts`

**Step 1: Add the new types**

Add to `test/e2e/fixtures/recorded/types.ts`:

```typescript
/** A single captured HTTP interaction or SSE event from OpenCode. */
export type OpenCodeInteraction =
	| {
			kind: "rest";
			method: string;
			path: string;
			requestBody?: unknown;
			status: number;
			responseBody: unknown;
	  }
	| {
			kind: "sse";
			type: string;
			properties: Record<string, unknown>;
			delayMs: number;
	  }
	| {
			/** PTY WebSocket connection opened */
			kind: "pty-open";
			ptyId: string;
			cursor: number; // 0 = new, -1 = reconnect
	  }
	| {
			/** Input sent from relay to PTY (text frame) */
			kind: "pty-input";
			ptyId: string;
			data: string;
			delayMs: number;
	  }
	| {
			/** Output received from PTY upstream (text frame, 0x00 metadata frames excluded) */
			kind: "pty-output";
			ptyId: string;
			data: string;
			delayMs: number;
	  }
	| {
			/** PTY WebSocket connection closed */
			kind: "pty-close";
			ptyId: string;
			code: number;
			reason: string;
			delayMs: number;
	  };

/** A full recorded session of OpenCode HTTP interactions. */
export interface OpenCodeRecording {
	name: string;
	recordedAt: string;
	opencodeVersion: string;
	interactions: OpenCodeInteraction[];
}
```

**Step 2: Verify types compile**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```
feat: add OpenCodeRecording type for HTTP-level fixture format
```

---

### Task 2: Build the Recording Proxy

**Files:**
- Create: `test/helpers/recording-proxy.ts`
- Test: `test/unit/helpers/recording-proxy.test.ts`

The recording proxy is a transparent HTTP proxy that forwards requests to a real OpenCode instance and captures every interaction (REST request/response pairs and SSE events).

**Step 1: Write a failing test**

Create `test/unit/helpers/recording-proxy.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { RecordingProxy } from "../../helpers/recording-proxy.js";

// Fake "OpenCode" server that returns canned responses
function createFakeUpstream(): Server {
	return createServer((req, res) => {
		if (req.url === "/path") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ cwd: "/tmp/test" }));
		} else if (req.url === "/session") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify([{ id: "ses_1", title: "Test" }]));
		} else if (req.url === "/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			setTimeout(() => {
				res.write(
					'data: {"type":"server.connected","properties":{}}\n\n',
				);
			}, 10);
			setTimeout(() => {
				res.write(
					'data: {"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"idle"}}}\n\n',
				);
			}, 20);
			// Don't end — SSE is long-lived
		} else {
			res.writeHead(404);
			res.end();
		}
	});
}

describe("RecordingProxy", () => {
	let upstream: Server;
	let upstreamPort: number;
	let proxy: RecordingProxy;

	beforeAll(async () => {
		upstream = createFakeUpstream();
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		upstreamPort = (upstream.address() as { port: number }).port;

		proxy = new RecordingProxy(`http://127.0.0.1:${upstreamPort}`);
		await proxy.start();
	});

	afterAll(async () => {
		await proxy.stop();
		await new Promise<void>((r) => upstream.close(() => r()));
	});

	it("proxies REST requests and records interactions", async () => {
		const res = await fetch(`${proxy.url}/path`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ cwd: "/tmp/test" });

		const recording = proxy.getRecording();
		const restEntries = recording.filter((i) => i.kind === "rest");
		expect(restEntries.length).toBeGreaterThanOrEqual(1);
		expect(restEntries[0]).toMatchObject({
			kind: "rest",
			method: "GET",
			path: "/path",
			status: 200,
		});
	});

	it("captures SSE events", async () => {
		// Connect to SSE endpoint through the proxy
		const controller = new AbortController();
		const res = await fetch(`${proxy.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		expect(res.status).toBe(200);

		// Wait for events to flow through
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();

		const recording = proxy.getRecording();
		const sseEntries = recording.filter((i) => i.kind === "sse");
		expect(sseEntries.length).toBeGreaterThanOrEqual(1);
		expect(sseEntries[0]).toMatchObject({
			kind: "sse",
			type: "server.connected",
		});
	});

	it("proxies PTY WebSocket connections and records frames", async () => {
		// This test requires the fake upstream to handle WS upgrades.
		// The fake upstream from createFakeUpstream() needs to be extended
		// with a WebSocket server on /pty/:id/connect for this test.
		// See implementation for details — the test should verify:
		// - pty-open interaction recorded on connect
		// - pty-input recorded when relay sends text frame
		// - pty-output recorded when upstream sends text frame
		// - pty-close recorded when connection closes
		// - 0x00-prefixed binary frames (cursor metadata) are NOT recorded
		const recording = proxy.getRecording();
		const ptyEntries = recording.filter(
			(i) => i.kind === "pty-open" || i.kind === "pty-input" ||
			        i.kind === "pty-output" || i.kind === "pty-close",
		);
		// Exact assertions depend on the fake upstream WS behavior
		expect(ptyEntries).toBeDefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/helpers/recording-proxy.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement RecordingProxy**

Create `test/helpers/recording-proxy.ts`:

The proxy should:
- Create an `http.createServer` that forwards all requests to the upstream OpenCode URL
- For non-SSE responses: buffer the response, record `{ kind: "rest", method, path, requestBody, status, responseBody }`, forward to the client
- For SSE responses (`text/event-stream`): pipe the response through, parse each `data:` line, record `{ kind: "sse", type, properties, delayMs }`
- **For WebSocket upgrades on `/pty/:id/connect`** (Issue #1, #14): use `ws` library to proxy the WebSocket connection to upstream. Record:
  - `{ kind: "pty-open", ptyId, cursor }` when the connection is established
  - `{ kind: "pty-input", ptyId, data, delayMs }` for text frames sent relay→upstream
  - `{ kind: "pty-output", ptyId, data, delayMs }` for text frames received upstream→relay (drop `0x00`-prefixed binary cursor metadata frames — they're not needed for replay)
  - `{ kind: "pty-close", ptyId, code, reason, delayMs }` when the connection closes
- Track `delayMs` as milliseconds since the previous event (SSE or PTY)
- Expose `start()`, `stop()`, `url` (the proxy's base URL), `getRecording()` (returns the `OpenCodeInteraction[]`), and `reset()` (clears captured interactions)

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/helpers/recording-proxy.test.ts`
Expected: PASS

**Step 5: Run full check**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```
feat: add RecordingProxy for capturing OpenCode HTTP interactions
```

---

### Task 3: Build the Mock OpenCode Server

**Files:**
- Create: `test/helpers/mock-opencode-server.ts`
- Test: `test/unit/helpers/mock-opencode-server.test.ts`

The mock server loads an `OpenCodeRecording` fixture and replays responses using queued matching.

**Step 1: Write a failing test**

Create `test/unit/helpers/mock-opencode-server.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import type { OpenCodeRecording } from "../../e2e/fixtures/recorded/types.js";

const FIXTURE: OpenCodeRecording = {
	name: "test-fixture",
	recordedAt: new Date().toISOString(),
	opencodeVersion: "1.2.6",
	interactions: [
		{ kind: "rest", method: "GET", path: "/path", status: 200, responseBody: { cwd: "/tmp" } },
		{ kind: "rest", method: "GET", path: "/session", status: 200, responseBody: [{ id: "ses_1" }] },
		{ kind: "rest", method: "GET", path: "/agent", status: 200, responseBody: [{ id: "coder", name: "Coder" }] },
		{ kind: "rest", method: "POST", path: "/session", status: 200, responseBody: { id: "ses_2", title: "New" } },
		{ kind: "rest", method: "GET", path: "/session", status: 200, responseBody: [{ id: "ses_1" }, { id: "ses_2" }] },
		{ kind: "rest", method: "DELETE", path: "/session/ses_2", status: 204, responseBody: null },
		{ kind: "rest", method: "GET", path: "/session", status: 200, responseBody: [{ id: "ses_1" }] },
		// prompt_async triggers SSE
		{ kind: "rest", method: "POST", path: "/session/ses_1/prompt_async", status: 200, responseBody: {} },
		{ kind: "sse", type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } }, delayMs: 0 },
		{ kind: "sse", type: "message.part.delta", properties: { sessionID: "ses_1", partID: "p1", field: "text", delta: "hello" }, delayMs: 5 },
		{ kind: "sse", type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } }, delayMs: 5 },
	],
};

describe("MockOpenCodeServer", () => {
	let mock: MockOpenCodeServer;

	beforeAll(async () => {
		mock = new MockOpenCodeServer(FIXTURE);
		await mock.start();
	});

	afterAll(async () => {
		await mock.stop();
	});

	it("serves REST responses from queued recording", async () => {
		// First GET /path
		const r1 = await fetch(`${mock.url}/path`);
		expect(r1.status).toBe(200);
		expect(await r1.json()).toEqual({ cwd: "/tmp" });

		// First GET /session
		const r2 = await fetch(`${mock.url}/session`);
		expect(r2.status).toBe(200);
		expect(await r2.json()).toEqual([{ id: "ses_1" }]);
	});

	it("dequeues successive responses for same endpoint", async () => {
		// GET /agent (only one in queue)
		const r1 = await fetch(`${mock.url}/agent`);
		expect(await r1.json()).toEqual([{ id: "coder", name: "Coder" }]);

		// POST /session
		const r2 = await fetch(`${mock.url}/session`, { method: "POST", body: "{}" });
		expect(await r2.json()).toEqual({ id: "ses_2", title: "New" });

		// Second GET /session (different response than first)
		const r3 = await fetch(`${mock.url}/session`);
		expect(await r3.json()).toEqual([{ id: "ses_1" }, { id: "ses_2" }]);

		// DELETE /session/ses_2
		const r4 = await fetch(`${mock.url}/session/ses_2`, { method: "DELETE" });
		expect(r4.status).toBe(204);

		// Third GET /session (back to just ses_1)
		const r5 = await fetch(`${mock.url}/session`);
		expect(await r5.json()).toEqual([{ id: "ses_1" }]);
	});

	it("returns last queued response when queue is exhausted", async () => {
		// GET /path was dequeued already; should return the last (only) response
		const res = await fetch(`${mock.url}/path`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ cwd: "/tmp" });
	});

	it("matches path parameters (e.g. /session/:id)", async () => {
		const res = await fetch(`${mock.url}/session/ses_2`, { method: "DELETE" });
		// Queue exhausted, returns last DELETE response
		expect(res.status).toBe(204);
	});

	it("streams SSE events after prompt_async", async () => {
		// Connect SSE
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		expect(sseRes.status).toBe(200);

		// Trigger prompt_async
		await fetch(`${mock.url}/session/ses_1/prompt_async`, {
			method: "POST",
			body: "{}",
		});

		// Collect SSE events
		const reader = sseRes.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const events: unknown[] = [];

		const collectPromise = (async () => {
			while (events.length < 3) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop()!;
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						events.push(JSON.parse(line.slice(6)));
					}
				}
			}
		})();

		await Promise.race([
			collectPromise,
			new Promise((r) => setTimeout(r, 2000)),
		]);
		controller.abort();

		expect(events.length).toBe(3);
		expect(events[0]).toMatchObject({ type: "session.status" });
		expect(events[1]).toMatchObject({ type: "message.part.delta" });
		expect(events[2]).toMatchObject({ type: "session.status" });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement MockOpenCodeServer**

Create `test/helpers/mock-opencode-server.ts`:

The mock server should:
- Accept an `OpenCodeRecording` in its constructor
- On `start()`, create an `http.createServer` listening on port 0
- Build response queues: group REST interactions by a normalized key (method + path pattern). Path pattern normalization replaces segments that look like IDs (e.g. `ses_*`, `msg_*`, UUIDs) with `:param`
- **SSE batch splitting (Issue #2):** Split SSE events into batches at EVERY REST call boundary (not just `prompt_async`). Walk the interactions array: accumulate SSE events into a batch until a REST interaction is hit, then associate that batch with the preceding REST interaction. When a REST response is dequeued, check if there's a pending SSE batch associated with it and emit it. This handles `POST /permission/:id/reply` triggering SSE events just like `prompt_async` does.
- Maintain a list of connected SSE clients (`response` objects for `GET /event` requests)
- **Immediate `server.connected` (Issue #5):** When a client connects to `GET /event`, immediately emit `data: {"type":"server.connected","properties":{}}\n\n` before any batch-triggered events.
- **SSE keepalive (Issue #4):** Send `: keepalive\n\n` every 15 seconds on all SSE connections to prevent relay reconnection logic from triggering.
- **Auth passthrough (Issue #6):** Do NOT validate `Authorization` headers. Ignore them entirely.
- On REST request: match to a queue by normalized method+path, dequeue next response (or return last if exhausted). After dequeuing, check for an associated SSE batch and emit it.
- **Response headers (Issue #11):** Set `Content-Type: application/json` for all non-204 responses.
- **DELETE 204 (Issue #12):** For 204 responses, send empty body with NO `Content-Type` header.
- **Queue exhaustion (Issue #13):** When a queue is exhausted, return the LAST recorded response. This handles polling endpoints like `GET /session/status` that the relay calls repeatedly.
- On SSE trigger: iterate the SSE batch, sending each event as `data: {json}\n\n` to all connected SSE clients, respecting `delayMs` (but capped to max 5ms per event to avoid slow tests)
- On `GET /event`: hold the connection open, write SSE headers, add to client list
- **PTY WebSocket (Issue #1):** Handle WebSocket upgrades on `/pty/:id/connect` using `ws` library. Replay recorded PTY interactions:
  - On upgrade: accept the WebSocket connection, find the matching `pty-open` interaction
  - When the next `pty-output` interaction is due (by delayMs), send it as a text frame
  - When the client sends a text frame, match it against the next `pty-input` interaction (for ordering)
  - On `pty-close`, close the WebSocket with the recorded code/reason
- **`reset()` method (Issue #10):** Add a `reset()` method that re-initializes all REST queues, SSE batches, and PTY queues from the original recording. Call this in `beforeEach` for test isolation.
- Expose `url`, `start()`, `stop()`, `reset()`

For path pattern normalization, a simple regex: replace path segments matching `/[a-z]{2,4}_[A-Za-z0-9]+/` or UUID patterns with `:param`. E.g.:
- `/session/ses_abc123` → `/session/:param`
- `/session/ses_abc123/message` → `/session/:param/message`
- `/session/ses_abc123/message/msg_def456` → `/session/:param/message/:param`

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: PASS

**Step 5: Run full check**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```
feat: add MockOpenCodeServer for replaying recorded HTTP interactions
```

---

### Task 4: Extend the Recording Script

**Files:**
- Modify: `test/e2e/scripts/record-snapshots.ts`

**Step 1: Import and integrate RecordingProxy**

Modify `record-snapshots.ts` to:
1. Import `RecordingProxy` from `../../helpers/recording-proxy.js`
2. Import `OpenCodeRecording` type from `../fixtures/recorded/types.js`
3. After spawning OpenCode and before creating the RelayStack, start a `RecordingProxy` pointed at the OpenCode URL
4. Point the RelayStack at the proxy URL instead of the OpenCode URL directly
5. After each scenario is recorded, save the proxy's captured interactions as `<name>.opencode.json` alongside the existing `<name>.json`
6. Call `proxy.reset()` between scenarios
7. Read the OpenCode version from `.opencode-version` file (or from the proxy's first `/path` response) and include it in the recording

The existing WS fixture recording remains unchanged — both `.json` (WS-level) and `.opencode.json` (HTTP-level) are saved.

**Step 2: Verify the script still compiles**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```
feat: extend record-snapshots to capture OpenCode HTTP-level recordings
```

---

### Task 5: Generate Initial Recordings

**Prerequisites:** A running OpenCode instance (or the script spawns one).

**Step 1: Run the recording script**

Run: `pnpm test:record-snapshots`
Expected: Generates both `.json` and `.opencode.json` files for all 10 scenarios in `test/e2e/fixtures/recorded/`

**Step 2: Verify fixture files exist**

Check that these new files were created:
- `test/e2e/fixtures/recorded/chat-simple.opencode.json`
- `test/e2e/fixtures/recorded/chat-tool-call.opencode.json`
- `test/e2e/fixtures/recorded/chat-result-bar.opencode.json`
- `test/e2e/fixtures/recorded/chat-multi-turn.opencode.json`
- `test/e2e/fixtures/recorded/chat-streaming.opencode.json`
- `test/e2e/fixtures/recorded/chat-thinking.opencode.json`
- `test/e2e/fixtures/recorded/permissions-read.opencode.json`
- `test/e2e/fixtures/recorded/permissions-bash.opencode.json`
- `test/e2e/fixtures/recorded/advanced-diff.opencode.json`
- `test/e2e/fixtures/recorded/advanced-mermaid.opencode.json`

**Step 3: Spot-check a fixture**

Open one `.opencode.json` file and verify it contains:
- `name`, `recordedAt`, `opencodeVersion` fields
- An `interactions` array with both `kind: "rest"` and `kind: "sse"` entries
- REST entries have `method`, `path`, `status`, `responseBody`
- SSE entries have `type`, `properties`, `delayMs`
- **Init-phase coverage (Issue #8):** Verify recordings include ALL init REST calls: `GET /path`, `GET /session`, `GET /agent`, `GET /provider`, `GET /config`, etc. The relay makes these on startup and tests like dashboard/pin specs depend on them.
- **Status transitions (Issue #13):** Verify SSE events include `session.status` transitions (busy → idle) so the relay's status tracking works correctly during replay.

**Step 4: Smoke-test the mock server with a real fixture**

Write a quick manual verification (or add to the mock server test):
- Load `chat-simple.opencode.json` into `MockOpenCodeServer`
- Start it, make a few requests, verify responses come back

**Step 5: Commit**

```
feat: generate initial OpenCode HTTP-level recordings for all scenarios
```

---

### Task 6: Record New Scenarios for Integration Tests

**Files:**
- Modify: `test/e2e/scripts/record-snapshots.ts` (add new scenarios)

Some integration tests require scenarios not covered by the existing 10. Add new scenarios to the `SCENARIOS` array:

| Scenario name | Prompts / behavior needed | Integration tests served |
|---|---|---|
| `session-crud` | Create session, rename it, list, delete, list again | session-lifecycle, ws-handler-coverage, discovery-endpoints |
| `multi-session` | Create 2 sessions, switch between them, send messages | per-tab-sessions, session-switch-history, switch-to-streaming-session |
| `cancel-flow` | Send prompt, abort mid-stream, send another prompt | cancel-lifecycle |
| `terminal-io` | Create PTY, send input, receive output, resize, close | terminal |

**Session ID determinism (Issue #3):** The recording script must use fixed, deterministic session titles (NOT `Date.now()`). Use `"test-session-1"`, `"test-session-2"`, etc. The integration tests that currently use `Date.now()` in session titles must be updated in Task 9 to match these fixed titles.

**Step 1: Add scenario definitions**

Add the new scenarios to the `SCENARIOS` array in `record-snapshots.ts`. Each scenario defines its prompts and any special flags (e.g. `needsPermissionApproval`).

For `session-crud`, the recording script would need to:
- Create a session via `{ type: "new_session" }`
- Send a rename via `{ type: "rename_session", ... }`
- Send a delete via `{ type: "delete_session", ... }`
This may require extending `recordTurn()` to handle non-prompt WS commands.

For `terminal-io`, the recording script needs to exercise PTY commands. This may require custom recording logic since PTY is WebSocket-based upstream.

**Step 2: Run the recording**

Run: `pnpm test:record-snapshots`
Expected: New `.opencode.json` files generated for the new scenarios

**Step 3: Commit**

```
feat: add integration-test scenarios to recording script
```

---

### Task 7: Extend recorded-loader.ts

**Files:**
- Modify: `test/e2e/helpers/recorded-loader.ts`

**Step 1: Add OpenCode recording loader**

Add a function to load `.opencode.json` fixtures:

```typescript
import type { OpenCodeRecording } from "../fixtures/recorded/types.js";

/** Load an OpenCode HTTP-level recording by name (without extension). */
export function loadOpenCodeRecording(name: string): OpenCodeRecording {
	const filePath = path.join(FIXTURES_DIR, `${name}.opencode.json`);
	const raw = readFileSync(filePath, "utf-8");
	return JSON.parse(raw) as OpenCodeRecording;
}
```

**Step 2: Verify it compiles**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```
feat: add loadOpenCodeRecording to recorded-loader
```

---

### Task 8: Migrate Integration Test Harness

**Files:**
- Modify: `test/integration/helpers/relay-harness.ts`

**Step 1: Update the harness to start a mock server**

Replace the `isOpenCodeRunning()` gate with mock server setup:

1. Import `MockOpenCodeServer` and `loadOpenCodeRecording`
2. Change `createRelayHarness()` to accept a `recordingName` parameter (defaults to `"chat-simple"`)
3. In setup: load the recording, start the mock server, point `RelayStack` at `mock.url` instead of `OPENCODE_URL`
4. In `stop()`: stop the mock server after stopping the relay
5. Remove the `isOpenCodeRunning` export (it stays in `opencode-utils.ts` for contract tests)
6. Remove `autoDetectFreeModel()` (the mock doesn't have real models to detect; the recording contains the model responses)

The updated `createRelayHarness()` signature:

```typescript
export async function createRelayHarness(
	recordingName = "chat-simple",
): Promise<RelayHarness>
```

**Step 2: Verify it compiles**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```
refactor: update integration harness to use MockOpenCodeServer
```

---

### Task 9: Migrate Integration Tests

**Files:**
- Modify: all 17 files in `test/integration/flows/`

For each integration test file:

1. Remove `import { isOpenCodeRunning } from ...`
2. Remove `const available = await isOpenCodeRunning()`
3. Replace `describe.skipIf(!available)("...", () => {` with `describe("...", () => {`
4. If the test needs a specific recording (e.g. `session-lifecycle` needs `session-crud`), pass that recording name to `createRelayHarness("session-crud")`
5. **Session ID determinism (Issue #3):** Replace any `Date.now()` session titles with deterministic values that match the recording (e.g. `"test-session-1"`). The mock dequeues responses in order, so the titles must match what was recorded.
6. **Test isolation (Issue #10):** Add `mock.reset()` in `beforeEach` (via the harness) to re-initialize queues between tests.

Work through files in order, running `pnpm vitest run test/integration/flows/<file>` after each to verify it passes.

**Mapping of test files to recordings:**

| File | Recording |
|---|---|
| `initial-state.integration.ts` | `chat-simple` (default) |
| `send-message.integration.ts` | `chat-simple` |
| `session-lifecycle.integration.ts` | `session-crud` |
| `terminal.integration.ts` | `terminal-io` |
| `sse-consumer.integration.ts` | `chat-simple` |
| `sse-to-ws-pipeline.integration.ts` | `chat-simple` |
| `rest-client.integration.ts` | `session-crud` |
| `ws-handler-coverage.integration.ts` | `session-crud` |
| `discovery-endpoints.integration.ts` | `chat-simple` |
| `error-handling.integration.ts` | `chat-simple` |
| `multi-client.integration.ts` | `chat-simple` |
| `per-tab-sessions.integration.ts` | `multi-session` |
| `session-switch-history.integration.ts` | `multi-session` |
| `cancel-lifecycle.integration.ts` | `cancel-flow` |
| `message-lifecycle.integration.ts` | `chat-simple` |
| `model-selection.integration.ts` | `chat-simple` |
| `switch-to-streaming-session.integration.ts` | `multi-session` |

Some mappings may need adjustment during implementation based on what the tests actually exercise.

**Step 1: Migrate first file (initial-state) as a proof of concept**

Run: `pnpm vitest run test/integration/flows/initial-state.integration.ts`
Expected: PASS (not skipped)

**Step 2: Migrate remaining 16 files**

Work through each file, running its test after migration.

**Step 3: Run full integration suite**

Run: `pnpm test:integration`
Expected: 17 files passed, 118 tests passed, 0 skipped

**Step 4: Commit**

```
refactor: remove OpenCode skip gates from all integration tests
```

---

### Task 10: Migrate E2E Playwright Config and Harness

**Files:**
- Modify: `test/e2e/playwright-replay.config.ts`
- Modify: `test/e2e/helpers/e2e-harness.ts`

**Step 1: Update the E2E harness**

Change `createE2EHarness()` in `e2e-harness.ts` to:
1. Accept a `recordingName` parameter
2. Start a `MockOpenCodeServer` with the recording
3. Point the `RelayStack` at `mock.url`
4. The harness now starts a real relay that serves the built frontend AND proxies to the mock

**Step 2: Update the Playwright config**

Change `playwright-replay.config.ts`:
- Remove the `webServer` block (no more `vite preview`). The relay itself serves the frontend from `dist/frontend/`.
- Use a `globalSetup` script (or Playwright fixture) that starts the E2E harness with the mock server and exposes the relay URL.
- Update `baseURL` to use the relay's dynamic port.

Alternative approach: use a Playwright fixture that starts the harness per-test or per-worker, since different specs may need different recordings.

**Step 3: Verify config change compiles**

Run: `pnpm check`
Expected: PASS

**Step 4: Commit**

```
refactor: update E2E config to use relay + mock OpenCode instead of vite preview
```

---

### Task 11: Migrate E2E Playwright Specs

**Files:**
- Modify: all spec files in `test/e2e/specs/` listed in the replay config

For each spec file:

1. Remove `import { mockRelayWebSocket } from "../helpers/ws-mock.js"`
2. Remove `import { buildResponseMap } from "../helpers/recorded-loader.js"`
3. Remove the `mockRelayWebSocket(page, { ... })` call from `beforeEach`
4. The test now hits the real relay (which talks to the mock OpenCode)
5. If the spec sends messages via `app.sendMessage(prompt)`, the prompt must match a recorded turn. The mock will trigger SSE events which flow through the relay to the browser naturally.
6. Remove any `WsMockControl` usage (mid-test injections). These scenarios now happen via the SSE pipeline.

**Key change:** Tests no longer control message injection directly. The flow is:
- User types in the chat input and clicks send
- Frontend sends `{ type: "message", text: "..." }` over WS to the relay
- Relay calls `POST /session/:id/prompt_async` on the mock
- Mock triggers the recorded SSE events
- Relay translates SSE → WS messages and sends to the browser
- Frontend renders the response

Tests that rely on `WsMockControl.sendMessages()` for permission approval flows need refactoring — the permission approval now goes through the full stack (frontend sends `permission_response` → relay calls `POST /permission/:id/reply` on mock → mock triggers next SSE batch).

**`waitForTimeout` replacement (Issue #7):** Replace all 35 `waitForTimeout` occurrences with proper `waitFor` + DOM assertions. For example:
- Instead of `await page.waitForTimeout(500)`, use `await expect(page.locator('.message')).toBeVisible()`
- Instead of `await page.waitForTimeout(1000)`, use `await page.waitForSelector('[data-testid="response"]')`
- This makes tests deterministic and eliminates flakiness from timing.

**Permission flow proof-of-concept (Issue #9):** Migrate `permissions-read.spec.ts` FIRST (before other permission specs) since the full-stack permission flow is the most complex: browser sends `permission_response` → relay calls `POST /permission/:id/reply` on mock → mock triggers next SSE batch with permission result → relay forwards to browser. Get this working end-to-end before tackling `permissions-bash.spec.ts`.

**Dashboard/pin specs (Issue #8):** Ensure E2E recordings include all init-phase REST calls that the relay makes on startup: `/path`, `/session`, `/agent`, `/provider`, `/config`, etc. The dashboard and pin specs rely on this state being fully populated.

**Step 1: Migrate `chat.spec.ts` first as proof of concept**

Run: `npx playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/chat.spec.ts`
Expected: PASS

**Step 2: Migrate remaining spec files one at a time**

Work through each spec, running it individually after migration.

**Step 3: Run full E2E replay suite**

Run: `pnpm test:e2e`
Expected: All specs pass

**Step 4: Commit**

```
refactor: remove WS mocking from E2E specs, use real relay + mock OpenCode
```

---

### Task 12: Clean Up

**Files:**
- Delete: `test/e2e/helpers/ws-mock.ts`
- Delete: `test/e2e/fixtures/recorded/*.json` (WS-level fixtures, keep `.opencode.json`)
- Delete: `test/e2e/fixtures/mockup-state.ts` (if no longer referenced)
- Modify: `test/e2e/helpers/recorded-loader.ts` (remove `buildResponseMap`, `ensureSessionSwitched` if unused)

**Step 1: Search for remaining references**

Search the codebase for any remaining imports of:
- `ws-mock.js` / `ws-mock`
- `buildResponseMap`
- `mockRelayWebSocket`
- `mockup-state`

Remove or update any references found.

**Step 2: Delete dead files**

Remove files listed above.

**Step 3: Run full test suite**

Run: `pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration`
Expected: All pass

**Step 4: Run E2E suite**

Run: `pnpm test:e2e`
Expected: All pass

**Step 5: Commit**

```
chore: remove deprecated WS fixtures and ws-mock infrastructure
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `pnpm check` — TypeScript compiles
- [ ] `pnpm lint` — Biome passes
- [ ] `pnpm test:unit` — All unit tests pass (including new mock server tests)
- [ ] `pnpm test:integration` — All 118 integration tests pass (0 skipped)
- [ ] `pnpm test:contract` — Contract tests still work (skip when no server)
- [ ] `pnpm test:e2e` — All E2E Playwright tests pass
- [ ] No test depends on a running OpenCode instance (except contract tests)
