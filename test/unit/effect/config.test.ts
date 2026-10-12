import { describe, it } from "@effect/vitest";
import { Either, Schema } from "effect";
import { expect } from "vitest";
import { DaemonConfigSchema } from "../../../src/lib/daemon/config-persistence.js";

describe("DaemonConfigSchema", () => {
	it("ignores dismissedPaths from older daemon.json files", () => {
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)({
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			projects: [{ path: "/app", slug: "app", addedAt: 1 }],
			dismissedPaths: ["/removed"],
		});
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.projects).toHaveLength(1);
			expect(result.right).not.toHaveProperty("dismissedPaths");
		}
	});

	it("validates a minimal config", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
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
			projects: [],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("accepts config without optional instances", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			projects: [],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.instances).toBeUndefined();
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
			projects: [],
			instances: [{ id: "x", name: "X", port: 4096 }],
		};
		const result = Schema.decodeUnknownEither(DaemonConfigSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});
