/**
 * CURSOR_API_KEY=... mise exec -- pnpm exec vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/cursor-sdk-live.test.ts
 * No agent is created and no turn is sent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import { makeAccountResourceScopesLive } from "../../../src/lib/domain/daemon/Layers/account-resource-scopes-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	CursorAccountResources,
	CursorAccountResourcesLive,
} from "../../../src/lib/provider/cursor/cursor-account-resources.js";
import { createCursorSdkPort } from "../../../src/lib/provider/cursor/cursor-sdk.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";

describe.skipIf(!process.env["CURSOR_API_KEY"])(
	"Cursor discovery (real SDK)",
	() => {
		it(
			"captures the live catalog and stored-login status without sending a turn",
			{ timeout: 60_000 },
			async () => {
				mkdirSync("test-results", { recursive: true });
				const configDir = mkdtempSync(resolve("test-results/cursor-sdk-live-"));
				const capture = resolve("test-results/xqsg-22-cursor-sdk-live.jsonl");
				rmSync(capture, { force: true });
				vi.stubEnv("CONDUIT_CURSOR_SDK_TRACE", "");
				vi.stubEnv("CONDUIT_CURSOR_SDK_CAPTURE", capture);
				try {
					const port = createCursorSdkPort();
					const probe = await port.probeRuntime();
					expect(probe).toEqual({ available: true });
					const lookup = await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const resources = yield* CursorAccountResources;
								return yield* resources.use(
									"cursor-live",
									({ credential }) => credential,
								);
							}),
						).pipe(
							Effect.provide(
								CursorAccountResourcesLive(
									configDir,
									join(configDir, "unused-legacy.json"),
								).pipe(
									Layer.provide(
										Layer.mergeAll(
											makeAccountResourceScopesLive(),
											DaemonEventBusLive,
											Layer.succeed(
												AccountDirectory,
												makeMockAccountDirectory([
													{
														driver: "cursor",
														id: AccountIdSchema.make("cursor-live"),
														name: "Cursor live",
														usageEligible: false,
													},
												]),
											),
										),
									),
								),
							),
						),
					);
					expect(lookup._tag).toBe("Ready");
					if (lookup._tag !== "Ready")
						throw new Error("Missing gated Cursor credential");
					const credential = lookup.credential;
					expect(credential.source).toBe("environment");
					const status = await port.authStatus();
					expect(["logged-in", "logged-out"]).toContain(status.status);
					const models = await port.modelsList(credential);
					expect(models.length).toBeGreaterThan(0);
					expect(models.every((model) => model.id && model.displayName)).toBe(
						true,
					);
					const trace = readFileSync(capture, "utf8");
					expect(trace.includes(Redacted.value(credential.apiKey))).toBe(false);
					const kinds = trace
						.trim()
						.split("\n")
						.map((line) => (JSON.parse(line) as { kind?: string }).kind);
					expect(kinds).toContain("models.list");
					expect(kinds).toContain("auth.status");
					expect(kinds).not.toContain("send.options");
				} finally {
					vi.unstubAllEnvs();
					rmSync(configDir, { recursive: true, force: true });
				}
			},
		);
	},
);
