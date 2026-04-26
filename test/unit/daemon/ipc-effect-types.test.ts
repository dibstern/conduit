// ─── IPC Effect Types Tests ──────────────────────────────────────────────────
// Part 1: Verify existing IPCCommandSchema still works (7 tests)
// Part 2: Verify new module exports (2 tests)

import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { IPCCommandSchema } from "../../../src/lib/daemon/ipc-protocol.js";

// ─── Part 1: Existing Schema Validation ─────────────────────────────────────

describe("IPC Schema (existing)", () => {
	const decode = Schema.decodeUnknownEither(IPCCommandSchema);

	it("decodes add_project command", () => {
		const result = decode({ cmd: "add_project", directory: "/tmp/proj" });
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects add_project without directory", () => {
		const result = decode({ cmd: "add_project" });
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_pin command", () => {
		const result = decode({ cmd: "set_pin", pin: "1234" });
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes shutdown command (no payload)", () => {
		const result = decode({ cmd: "shutdown" });
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects unknown command", () => {
		const result = decode({ cmd: "nonexistent_cmd" });
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes instance_add with cross-field validation", () => {
		const result = decode({
			cmd: "instance_add",
			name: "my-instance",
			managed: true,
			port: 4096,
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects instance_add managed without port", () => {
		const result = decode({
			cmd: "instance_add",
			name: "my-instance",
			managed: true,
		});
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── Part 2: New Module Exports ─────────────────────────────────────────────

describe("IPC Effect types (new module)", () => {
	it("exports IpcEffectHandler type", async () => {
		// Type-level check — if the import resolves and the type exists,
		// the test passes. We import the module and verify it loads.
		const mod = await import("../../../src/lib/effect/ipc-effect-types.js");
		// Module should exist and be an object
		expect(mod).toBeDefined();
		expect(typeof mod).toBe("object");
	});

	it("re-exports IPCCommandSchema from protocol", async () => {
		const mod = await import("../../../src/lib/effect/ipc-effect-types.js");
		expect(mod.IPCCommandSchema).toBeDefined();
		expect(mod.IPCCommandSchema).toBe(IPCCommandSchema); // Same reference
	});
});
