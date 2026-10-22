import { describe, it } from "@effect/vitest";
import { Result as Either, Schema } from "effect";
import { expect } from "vitest";
import { DaemonConfigSchema } from "../../../src/lib/daemon/config-persistence.js";

describe("DaemonConfigSchema", () => {
	it("ignores dismissedPaths from older daemon.json files", () => {
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)({
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			projects: [{ path: "/app", slug: "app", addedAt: 1 }],
			dismissedPaths: ["/removed"],
		});
		expect(Either.isSuccess(result)).toBe(true);
		if (Either.isSuccess(result)) {
			expect(result.success.projects).toHaveLength(1);
			expect(result.success).not.toHaveProperty("dismissedPaths");
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
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isSuccess(result)).toBe(true);
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
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isSuccess(result)).toBe(true);
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
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isFailure(result)).toBe(true);
	});

	it("rejects config missing required fields", () => {
		const raw = { projects: [], instances: [] };
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isFailure(result)).toBe(true);
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
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isFailure(result)).toBe(true);
	});

	it("migrates a legacy config without instances to one ordinary Claude default", () => {
		const raw = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			projects: [],
		};
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isSuccess(result)).toBe(true);
		if (Either.isSuccess(result)) {
			expect(result.success.instances).toEqual([
				{
					id: "claude",
					colorSlot: 0,
					name: "Claude",
					driver: "claude",
					port: 0,
					managed: false,
				},
			]);
			expect(result.success.accountDefaults).toEqual({ claude: "claude" });
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
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isFailure(result)).toBe(true);
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
		const result = Schema.decodeUnknownResult(DaemonConfigSchema)(raw);
		expect(Either.isFailure(result)).toBe(true);
	});
});
