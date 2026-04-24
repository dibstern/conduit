// ─── Tests: DaemonConfig Schema & ServerConfigLive Layer ─────────────────────

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DaemonConfigSchema,
	DaemonConfigTag,
	ServerConfigLive,
} from "../../../src/lib/daemon/config-persistence.js";

// ─── Schema validation tests ───────────────────────────────────────────────

describe("DaemonConfigSchema", () => {
	it("validates a minimal config", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("validates config with all optional fields", () => {
		const raw = {
			pid: 42,
			port: 8080,
			pinHash: "abc123",
			tls: true,
			debug: true,
			keepAwake: true,
			keepAwakeCommand: "systemd-inhibit",
			keepAwakeArgs: ["--what=idle"],
			dangerouslySkipPermissions: false,
			projects: [
				{
					path: "/src/app",
					slug: "app",
					title: "My App",
					addedAt: 1000,
					instanceId: "default",
					sessionCount: 5,
				},
			],
			instances: [
				{
					id: "personal",
					name: "Personal",
					port: 4096,
					managed: true,
					env: { API_KEY: "sk-test" },
					url: "http://localhost:4096",
				},
			],
			dismissedPaths: ["/tmp/old-project"],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects config with projects as a non-array", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: "not an array",
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects config missing required fields", () => {
		const raw = { projects: [], instances: [] };
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects config with wrong type for pid", () => {
		const raw = {
			pid: "not a number",
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("accepts config without optional instances/dismissedPaths", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.instances).toBeUndefined();
			expect(result.right.dismissedPaths).toBeUndefined();
		}
	});

	it("rejects project with missing slug", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [{ path: "/src/app", addedAt: 1000 }],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects instance with missing managed field", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances: [{ id: "x", name: "X", port: 4096 }],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── ServerConfigLive Layer tests ──────────────────────────────────────────

describe("ServerConfigLive", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "config-layer-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates defaults when daemon.json is missing", async () => {
		const program = Effect.gen(function* () {
			return yield* DaemonConfigTag;
		});

		const config = await Effect.runPromise(
			program.pipe(Effect.provide(ServerConfigLive(tempDir))),
		);

		expect(config.pid).toBe(process.pid);
		expect(config.port).toBe(2633);
		expect(config.pinHash).toBeNull();
		expect(config.projects).toEqual([]);

		// Should also have written the file
		const written = JSON.parse(
			readFileSync(join(tempDir, "daemon.json"), "utf-8"),
		);
		expect(written.port).toBe(2633);
	});

	it("reads and validates existing daemon.json", async () => {
		mkdirSync(tempDir, { recursive: true });
		const saved = {
			pid: 99,
			port: 8080,
			pinHash: "hash",
			tls: true,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [{ path: "/app", slug: "app", addedAt: 1000 }],
			instances: [{ id: "i1", name: "Instance", port: 4096, managed: true }],
		};
		writeFileSync(join(tempDir, "daemon.json"), JSON.stringify(saved), "utf-8");

		const program = Effect.gen(function* () {
			return yield* DaemonConfigTag;
		});

		const config = await Effect.runPromise(
			program.pipe(Effect.provide(ServerConfigLive(tempDir))),
		);

		expect(config.pid).toBe(99);
		expect(config.port).toBe(8080);
		expect(config.tls).toBe(true);
		expect(config.projects).toHaveLength(1);
		expect(config.instances).toHaveLength(1);
	});

	it("fails on invalid daemon.json", async () => {
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "daemon.json"),
			JSON.stringify({ pid: "wrong", port: "bad" }),
			"utf-8",
		);

		const program = Effect.gen(function* () {
			return yield* DaemonConfigTag;
		});

		await expect(
			Effect.runPromise(
				program.pipe(
					Effect.provide(ServerConfigLive(tempDir)),
				) as Effect.Effect<unknown>,
			),
		).rejects.toThrow();
	});
});
