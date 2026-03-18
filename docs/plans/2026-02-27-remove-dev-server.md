# Remove Dev-Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `src/dev-server.ts` with a `--foreground` CLI flag that runs the full Daemon in-process with hot reload support.

**Architecture:** Add `"foreground"` to the CLI command union. The handler creates a `Daemon`, calls `start()`, then auto-registers CWD as a project. No changes to the Daemon class itself. Update scripts, Docker config, and delete dev-server.ts.

**Tech Stack:** TypeScript, tsx watch, Vite, Docker Compose

---

### Task 1: Add `"foreground"` to ParsedArgs command union

**Files:**
- Modify: `src/bin/cli-core.ts:31-42`

**Step 1: Write the failing test**

In `test/unit/cli.test.ts`, inside the `T1: parseArgs` describe block, add:

```typescript
it("--foreground flag", () => {
	const args = parseArgs(["--foreground"]);
	expect(args.command).toBe("foreground");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/cli.test.ts --grep "foreground flag"`
Expected: FAIL — `"foreground"` is not in the union / switch doesn't handle it

**Step 3: Add foreground to command union and parseArgs switch**

In `src/bin/cli-core.ts`, add `"foreground"` to the `ParsedArgs.command` union type (line 42):

```typescript
export interface ParsedArgs {
	command:
		| "default"
		| "daemon"
		| "foreground"
		| "status"
		| "stop"
		| "pin"
		| "add"
		| "remove"
		| "list"
		| "title"
		| "help";
	// ... rest unchanged
}
```

In the `parseArgs` switch statement (after `case "--daemon"`), add:

```typescript
case "--foreground":
	result.command = "foreground";
	break;
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/cli.test.ts --grep "foreground flag"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bin/cli-core.ts test/unit/cli.test.ts
git commit -m "feat: add --foreground flag to CLI arg parser"
```

---

### Task 2: Add --foreground handler in run()

**Files:**
- Modify: `src/bin/cli-core.ts:362-386`

**Step 1: Write the failing test**

In `test/unit/cli.test.ts`, add a new describe block for the foreground command. The test should verify that:
- A Daemon is created with the correct options
- `daemon.start()` is called
- `daemon.addProject(cwd)` is called with the CWD

Use the existing test patterns — the CLI tests use injectable options (mock `sendIPC`, `isDaemonRunning`, `spawnDaemon`, etc.). For the foreground handler, we need to verify the Daemon is instantiated correctly. Since the foreground handler creates the Daemon directly (not through a factory), the simplest approach is to mock the Daemon module or verify the output messages.

```typescript
describe("--foreground handler", () => {
	it("starts daemon in foreground and auto-registers CWD", async () => {
		const output: string[] = [];
		const mockStdout = { write: (s: string) => { output.push(s); } };

		await run(["--foreground"], {
			cwd: "/test/project",
			stdout: mockStdout,
			stderr: mockStdout,
			exit: () => {},
		});

		// Verify it logged startup info
		const joined = output.join("");
		expect(joined).toContain("foreground");
		expect(joined).toContain("2633"); // default port
	});
});
```

Note: This test will actually start a real Daemon (HTTP server, IPC server). Use `afterEach` to clean up, or adjust to mock at the module level. Check existing daemon test patterns for how they handle this. If real server startup is too heavy, the test can verify args parsing and the handler is reached, then skip the actual start.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/cli.test.ts --grep "foreground handler"`
Expected: FAIL — no handler for "foreground" command

**Step 3: Add the foreground handler**

In `src/bin/cli-core.ts`, after the `--daemon` handler block (line 386) and before `--help`, add:

```typescript
// ─── --foreground (dev mode: run daemon in current process) ──────
if (args.command === "foreground") {
	const opencodeUrl =
		process.env.OPENCODE_URL ||
		`http://localhost:${args.ocPort}`;

	stdout.write(`\nOpenCode Relay (foreground)\n`);
	stdout.write(`  OpenCode: ${opencodeUrl}\n`);

	const daemon = new Daemon({
		port: args.port,
		opencodeUrl,
	});

	await daemon.start();
	await daemon.addProject(cwd);

	stdout.write(`  Relay:    http://localhost:${args.port}\n`);
	stdout.write(`  Project:  ${cwd}\n`);
	stdout.write(`  Ready.\n\n`);
	return;
}
```

Key design decisions:
- Reads `OPENCODE_URL` env var first (for Docker: `http://opencode:4096`), falls back to `http://localhost:${ocPort}` (for local dev)
- Uses existing `--port` and `--oc-port` CLI args — no new flags needed
- Calls `addProject(cwd)` after `start()` to auto-register CWD
- Signal handlers are installed by `daemon.start()` — they call `daemon.stop()` on SIGTERM/SIGINT, which tsx watch sends before restarting

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/cli.test.ts --grep "foreground handler"`
Expected: PASS (may need to adjust test expectations based on actual output format)

**Step 5: Commit**

```bash
git add src/bin/cli-core.ts test/unit/cli.test.ts
git commit -m "feat: add --foreground handler to run daemon in-process"
```

---

### Task 3: Add --foreground to HELP_TEXT

**Files:**
- Modify: `src/bin/cli-core.ts:304-325`

**Step 1: Update HELP_TEXT**

Add `--foreground` to the options list in `HELP_TEXT`:

```
  --foreground           Run daemon in foreground (for dev with tsx watch)
```

Place it after `--dangerously-skip-permissions` and before `-h, --help`.

**Step 2: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bin/cli-core.ts
git commit -m "docs: add --foreground to CLI help text"
```

---

### Task 4: Update package.json scripts

**Files:**
- Modify: `package.json:10-43`

**Step 1: Update scripts**

Replace:
```json
"dev": "tsx watch src/dev-server.ts",
"dev:all": "trap 'kill 0' EXIT; tsx watch src/dev-server.ts & vite & wait",
```

With:
```json
"dev": "tsx watch src/bin/cli.ts -- --foreground",
"dev:all": "trap 'kill 0' EXIT; tsx watch src/bin/cli.ts -- --foreground & vite & wait",
```

Add new script:
```json
"preview:server": "pnpm build && node dist/src/bin/cli.js",
```

Place `preview:server` after `preview:frontend`.

**Step 2: Verify scripts parse correctly**

Run: `node -e "const p = require('./package.json'); console.log(p.scripts.dev, p.scripts['dev:all'], p.scripts['preview:server'])"`
Expected: Prints the three updated/new scripts

**Step 3: Commit**

```bash
git add package.json
git commit -m "feat: update dev scripts to use --foreground daemon mode"
```

---

### Task 5: Update Dockerfile.dev

**Files:**
- Modify: `Dockerfile.dev:24-26`

**Step 1: Update CMD**

Replace:
```dockerfile
CMD ["sh", "-c", "pnpm tsx watch src/dev-server.ts & pnpm vite --host 0.0.0.0 & wait"]
```

With:
```dockerfile
CMD ["sh", "-c", "pnpm tsx watch src/bin/cli.ts -- --foreground & pnpm vite --host 0.0.0.0 & wait"]
```

**Step 2: Commit**

```bash
git add Dockerfile.dev
git commit -m "feat: update Dockerfile.dev to use --foreground daemon mode"
```

---

### Task 6: Update docker-compose.yml watch paths

**Files:**
- Modify: `docker-compose.yml:114-145`

**Step 1: Replace dev-server.ts sync with src/bin sync**

In the `relay-dev` service `develop.watch` section, replace:

```yaml
# Dev server entry point
- action: sync
  path: ./src/dev-server.ts
  target: /app/src/dev-server.ts
```

With:

```yaml
# CLI entry point (--foreground mode)
- action: sync
  path: ./src/bin
  target: /app/src/bin
```

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: update docker-compose watch to sync src/bin instead of dev-server.ts"
```

---

### Task 7: Delete dev-server.ts

**Files:**
- Delete: `src/dev-server.ts`

**Step 1: Remove the file**

```bash
git rm src/dev-server.ts
```

**Step 2: Search for any remaining references**

Search for `dev-server` in the codebase to find any remaining references (docs, configs, comments). Update or remove them.

Known references to check:
- `.dockerignore` — should not reference dev-server.ts specifically
- Any markdown docs in `docs/` that mention dev-server.ts
- Comments in other source files

**Step 3: Run full test suite**

Run: `pnpm test:unit`
Expected: All tests pass — no test imports dev-server.ts

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: remove dev-server.ts — replaced by --foreground daemon mode"
```

---

### Task 8: Verify full workflow

**Step 1: Test pnpm dev:all locally**

Run: `pnpm dev:all`

Verify:
- Daemon starts in foreground (check output for "foreground" / port info)
- Vite dev server starts on :5173
- CWD is auto-registered as a project
- IPC socket is created (`ls ~/.opencode-relay/relay.sock`)
- PID file is created (`cat ~/.opencode-relay/daemon.pid`)
- Ctrl+C cleanly shuts down both processes

**Step 2: Test hot reload**

With `pnpm dev:all` running:
- Make a trivial change to a backend file (e.g., add a log line to `src/lib/daemon.ts`)
- Verify tsx watch restarts the daemon
- Verify Vite frontend is still accessible
- Verify WebSocket reconnects after backend restart

**Step 3: Test preview:server**

Run: `pnpm preview:server`

Verify:
- Build completes
- Full interactive CLI launches (wizard, daemon spawns in background)
- IPC communication works

**Step 4: Run the full test suite one more time**

Run: `pnpm test:unit && pnpm check`
Expected: All pass

**Step 5: Commit any fixups if needed**
