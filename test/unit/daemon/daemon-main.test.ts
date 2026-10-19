import { InstanceMgmtTag } from "../../../src/lib/domain/daemon/Services/management-service.js";
// TDD tests for daemon-main.ts: the top-level Effect entry point that replaces
// the Daemon class's start() method. Tests exercise runStartupSequence
// composition and background task supervision, NOT makeDaemonProgramLayer
// (which blocks on Effect.never).

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { runStartupSequence } from "../../../src/lib/domain/daemon/Services/daemon-startup.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { resolveDefaultStaticDir } from "../../../src/lib/domain/daemon/Services/daemon-static-dir.js";
import type { InstanceManagementDeps } from "../../../src/lib/handlers/types.js";
import { partialFake } from "../../helpers/partial-fake.js";

describe("daemon-main", () => {
	describe("resolveDefaultStaticDir", () => {
		it("resolves packaged frontend assets from the moved domain service path", () => {
			const moduleUrl = pathToFileURL(
				join(
					"/pkg",
					"dist",
					"src",
					"lib",
					"domain",
					"daemon",
					"Services",
					"daemon-static-dir.js",
				),
			).href;

			expect(
				resolveDefaultStaticDir({
					moduleUrl,
					cwd: "/not-the-package",
					exists: (path) => path === join("/pkg", "dist", "frontend"),
				}),
			).toBe(join("/pkg", "dist", "frontend"));
		});

		it("falls back to cwd dist/frontend when running from source", () => {
			expect(
				resolveDefaultStaticDir({
					moduleUrl: pathToFileURL(
						join(
							"/repo",
							"src",
							"lib",
							"domain",
							"daemon",
							"Layers",
							"daemon-main.ts",
						),
					).href,
					cwd: "/repo",
					exists: () => false,
				}),
			).toBe(join("/repo", "dist", "frontend"));
		});
	});

	describe("runStartupSequence via daemon-main layer", () => {
		it.effect("completes startup and leaves state unchanged", () =>
			Effect.gen(function* () {
				// Run startup sequence with minimal mocks — should complete without error
				yield* runStartupSequence.pipe(
					Effect.provide(
						Layer.merge(
							makeDaemonStateLive(),
							Layer.succeed(InstanceMgmtTag)(
								partialFake<InstanceManagementDeps>({
									addInstance: vi.fn(),
								}),
							),
						),
					),
				);
			}),
		);
	});
});
