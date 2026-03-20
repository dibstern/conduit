# CLI URL Display Cleanup Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Clean up the CLI banner URL display so the setup URL appears as a QR caption, Tailscale stays primary with a labeled LAN fallback, and at most 2 URLs appear in the URL block.

**Architecture:** Replace the `setupUrl` field on `DaemonInfo` with `qrCaption`. Move setup URL rendering from the URL block to directly beneath the QR code. Add `Local:` label to network URLs.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Update DaemonInfo interface and renderStatus

**Files:**
- Modify: `src/lib/cli/cli-menu.ts:16-28` (DaemonInfo interface)
- Modify: `src/lib/cli/cli-menu.ts:66-97` (renderStatus function)
- Modify: `test/unit/cli/cli-menu.test.ts:55-66` (defaultDaemonInfo helper)

**Step 1: Update the DaemonInfo interface**

In `src/lib/cli/cli-menu.ts`, replace `setupUrl` with `qrCaption`:

```typescript
export interface DaemonInfo {
	port: number;
	url: string;
	networkUrls: string[];
	projectCount: number;
	sessionCount: number;
	processingCount: number;
	version: string;
	/** QR code art string for the relay URL (optional). */
	qrCode?: string;
	/** Caption shown under the QR code, e.g. "Scan or visit: http://…/setup" (optional). */
	qrCaption?: string;
}
```

**Step 2: Update renderStatus to render caption under QR and label network URLs**

Replace the renderStatus body in `src/lib/cli/cli-menu.ts`:

```typescript
export function renderStatus(info: DaemonInfo, stdout: Writable): void {
	log(`${a.dim}v${info.version}${a.reset}`, stdout);
	log("", stdout);

	// Show QR code if available (indent each line with 2 spaces)
	if (info.qrCode) {
		const lines = info.qrCode.split("\n").map((l) => `  ${l}`);
		for (const line of lines) {
			log(line, stdout);
		}
		// Show caption directly under QR (e.g. "Scan or visit: http://…/setup")
		if (info.qrCaption) {
			log(`  ${a.dim}${info.qrCaption}${a.reset}`, stdout);
		}
		log("", stdout);
	}

	log(`${a.bold}${info.url}${a.reset}`, stdout);
	for (const url of info.networkUrls) {
		log(`  ${a.dim}Local: ${url}${a.reset}`, stdout);
	}
	log("", stdout);

	const items = [
		`${info.projectCount} project${info.projectCount !== 1 ? "s" : ""}`,
		`${info.sessionCount} session${info.sessionCount !== 1 ? "s" : ""}`,
	];
	if (info.processingCount > 0) {
		items.push(`${a.yellow}${info.processingCount} processing${a.reset}`);
	}
	log(formatStatusLine(items), stdout);
	log("", stdout);
}
```

Key changes:
- `qrCaption` rendered dim, indented 2 spaces, right after QR lines (before the blank line)
- `setupUrl` rendering removed entirely
- Network URLs prefixed with `Local: `

**Step 3: Update test helper**

In `test/unit/cli/cli-menu.test.ts`, the `defaultDaemonInfo` helper doesn't include `setupUrl` by default, so no change needed there. But we need to update/add tests.

**Step 4: Update existing tests and add new ones**

In `test/unit/cli/cli-menu.test.ts`:

First, update the existing "displays network URLs" test (line 141) to validate the `Local:` prefix:

```typescript
it("displays network URLs with Local: prefix", () => {
	const io = createMockIO();
	const info = defaultDaemonInfo({
		networkUrls: ["http://192.168.1.50:2633", "http://10.0.0.5:2633"],
	});
	renderStatus(info, io.stdout);
	const text = io.text();
	expect(text).toContain("Local: http://192.168.1.50:2633");
	expect(text).toContain("Local: http://10.0.0.5:2633");
});
```

Also update the integration test "displays network URLs when present" (line 792) to validate `Local:`:

```typescript
it("displays network URLs when present", async () => {
	const io = createMockIO();
	void showMainMenu(
		io.opts({
			getDaemonInfo: () =>
				defaultDaemonInfo({
					networkUrls: ["http://192.168.1.100:2633"],
				}),
		}),
	);
	await tick();

	expect(io.text()).toContain("Local: http://192.168.1.100:2633");

	// Clean up
	io.stdin.emit("data", "\x03");
	await tick();
});
```

Then add new tests in the `renderStatus` describe block:

```typescript
it("displays qrCaption under QR code", () => {
	const io = createMockIO();
	const info = defaultDaemonInfo({
		qrCode: "LINE1\nLINE2",
		qrCaption: "Scan or visit: http://10.0.0.1:2634/setup",
	});
	renderStatus(info, io.stdout);
	const text = io.text();
	expect(text).toContain("Scan or visit: http://10.0.0.1:2634/setup");
});

it("does not show qrCaption when no QR code", () => {
	const io = createMockIO();
	const info = defaultDaemonInfo({
		qrCaption: "Scan or visit: http://10.0.0.1:2634/setup",
	});
	renderStatus(info, io.stdout);
	expect(io.text()).not.toContain("Scan or visit");
});

it("shows QR without caption when qrCaption absent (non-TLS)", () => {
	const io = createMockIO();
	const info = defaultDaemonInfo({
		qrCode: "LINE1\nLINE2",
	});
	renderStatus(info, io.stdout);
	const text = io.text();
	expect(text).toContain("LINE1");
	expect(text).not.toContain("Scan or visit");
});

it("labels network URLs with Local:", () => {
	const io = createMockIO();
	const info = defaultDaemonInfo({
		networkUrls: ["https://192.168.1.50:2633"],
	});
	renderStatus(info, io.stdout);
	expect(io.text()).toContain("Local: https://192.168.1.50:2633");
});

it("does not show setupUrl (removed field)", () => {
	const io = createMockIO();
	const info = defaultDaemonInfo();
	renderStatus(info, io.stdout);
	expect(io.text()).not.toContain("Setup:");
});
```

**Step 5: Run tests**

```bash
pnpm vitest run test/unit/cli/cli-menu.test.ts
```

Expected: All tests pass, including the new ones.

**Step 6: Commit**

```bash
git add src/lib/cli/cli-menu.ts test/unit/cli/cli-menu.test.ts
git commit -m "refactor(cli): move setup URL to QR caption, add Local: label to network URLs"
```

---

### Task 2: Update buildDaemonInfo in cli-commands.ts

**Files:**
- Modify: `src/bin/cli-commands.ts:129-167` (buildDaemonInfo function)

**Step 1: Replace setupUrl with qrCaption**

In `src/bin/cli-commands.ts`, update the `buildDaemonInfo` function. Replace lines 155-166:

```typescript
		version: "0.1.0",
		// When TLS is active, QR should point to the HTTP onboarding server
		// (port+1) so the phone installs the CA cert before accessing HTTPS.
		...(ip !== "localhost" && {
			qrCode: qr(tls ? `http://${ip}:${port + 1}/setup` : url),
		}),
		// Show QR caption when TLS is active (setup URL differs from primary)
		...(tls &&
			ip !== "localhost" && {
				qrCaption: `Scan or visit: http://${ip}:${port + 1}/setup`,
			}),
```

This replaces `setupUrl` with `qrCaption`. The QR code generation logic stays the same.

**Step 2: Run type check**

```bash
pnpm check
```

Expected: No type errors (the interface change from Task 1 should align).

**Step 3: Run tests**

```bash
pnpm vitest run test/unit/cli/cli-menu.test.ts
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/bin/cli-commands.ts
git commit -m "refactor(cli): buildDaemonInfo uses qrCaption instead of setupUrl"
```

---

### Task 3: Update non-interactive legacy path in cli-core.ts

**Files:**
- Modify: `src/bin/cli-core.ts:6` (add import)
- Modify: `src/bin/cli-core.ts:655-686` (non-interactive display — keep lines 652-654 intact)

**Step 1: Add import for getTailscaleIP**

`getTailscaleIP` is NOT currently imported in `cli-core.ts`. Add it after the existing imports (after line 11):

```typescript
import { getTailscaleIP } from "../lib/cli/tls.js";
```

Note: The interactive path in `cli-commands.ts:134` already calls `getTailscaleIP()` directly (not injected), so this is consistent. The `getAddr` injection exists for LAN IP testing; Tailscale detection doesn't need the same injection.

**Step 2: Restructure the non-interactive display**

Keep lines 652-654 (statusResponse and scheme) intact. Replace lines 655-686 (from `const ip = getAddr()...` through end of function):

```typescript
	// 3b. Build URLs with Tailscale priority (consistent with interactive path)
	const tsIP = getTailscaleIP();
	const lanIP = getAddr();
	const primaryIP = tsIP ?? lanIP ?? "localhost";
	const url = `${scheme}://${primaryIP}:${args.port}`;
	const tlsActive = statusResponse["tlsEnabled"] === true;

	// 4. Show QR code with optional setup caption
	if (primaryIP !== "localhost") {
		const qrUrl =
			tlsActive
				? `http://${primaryIP}:${args.port + 1}/setup`
				: url;
		const qrCode = qr(qrUrl);
		if (qrCode) {
			stdout.write("\n");
			stdout.write(qrCode);
			if (tlsActive) {
				stdout.write(
					`  Scan or visit: http://${primaryIP}:${args.port + 1}/setup\n`,
				);
			}
			stdout.write("\n");
		}
	}

	// 5. Display connection info
	stdout.write("\n");
	stdout.write("conduit\n");
	stdout.write(`  URL: ${url}\n`);
	if (tsIP && lanIP && tsIP !== lanIP) {
		stdout.write(`  Local: ${scheme}://${lanIP}:${args.port}\n`);
	}

	if (slug) {
		stdout.write(`  Project: ${slug} (${cwd})\n`);
	}

	// 6. Show PIN info
	stdout.write("Tip: Set a PIN for security: conduit --pin <4-8 digits>\n");
	stdout.write("\n");
```

**Step 3: Run type check and lint**

```bash
pnpm check && pnpm lint
```

Expected: No errors.

**Step 4: Run full unit tests**

```bash
pnpm test:unit
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/bin/cli-core.ts
git commit -m "refactor(cli): non-interactive path uses QR caption and Local: label"
```

---

### Task 4: Verify end-to-end

**Step 1: Run full verification**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: All pass.

**Step 2: Manual smoke test (if daemon is running)**

Restart the CLI menu and verify:
- QR code shows with caption underneath when TLS active
- Only 2 URLs max in the URL block (primary bold + optional `Local:` dim)
- No `Setup:` line in the URL block
- When no TLS, QR shows without caption
