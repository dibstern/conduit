/**
 * CURSOR_API_KEY=... mise exec -- pnpm exec vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/cursor-sdk-live.test.ts
 * No agent is created and no turn is sent.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCursorCredential } from "../../../src/lib/provider/cursor/cursor-credential.js";
import { createCursorSdkPort } from "../../../src/lib/provider/cursor/cursor-sdk.js";

describe.skipIf(!process.env["CURSOR_API_KEY"])(
	"Cursor discovery (real SDK)",
	() => {
		it(
			"captures the live catalog and stored-login status without sending a turn",
			async () => {
				mkdirSync("test-results", { recursive: true });
				const capture = resolve("test-results/xqsg-22-cursor-sdk-live.jsonl");
				rmSync(capture, { force: true });
				vi.stubEnv("CONDUIT_CURSOR_SDK_TRACE", "");
				vi.stubEnv("CONDUIT_CURSOR_SDK_CAPTURE", capture);
				try {
					const port = createCursorSdkPort();
					const probe = await port.probeRuntime();
					expect(probe).toEqual({ available: true });
					const credential = await resolveCursorCredential(port);
					expect(credential?.source).toBe("environment");
					if (!credential) throw new Error("Missing gated Cursor credential");
					const status = await port.authStatus();
					expect(["logged-in", "logged-out"]).toContain(status.status);
					const models = await port.modelsList(credential);
					expect(models.length).toBeGreaterThan(0);
					expect(models.every((model) => model.id && model.displayName)).toBe(
						true,
					);
					const trace = readFileSync(capture, "utf8");
					expect(trace.includes(credential.apiKey)).toBe(false);
					const kinds = trace
						.trim()
						.split("\n")
						.map((line) => (JSON.parse(line) as { kind?: string }).kind);
					expect(kinds).toContain("models.list");
					expect(kinds).toContain("auth.status");
					expect(kinds).not.toContain("send.options");
				} finally {
					vi.unstubAllEnvs();
				}
			},
			{ timeout: 60_000 },
		);
	},
);
