// ─── Property-Based Tests: IPC Protocol (Ticket 3.2) ────────────────────────
//
// Properties tested:
// P1: parseCommand accepts valid JSON with cmd field, rejects invalid (AC2)
// P2: serializeResponse always produces valid JSON + newline (AC2)
// P3: validateCommand returns null for valid commands, error for invalid (AC6)
// P4: Unknown commands always produce error response (AC6)
// P5: generateSlug always produces unique, non-empty, lowercase slug (AC3)
// P6: JSON-lines roundtrip: serialize→parse preserves response (AC2)
// P7: Command router dispatches to correct handler (AC2-AC5)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createCommandRouter,
	parseCommand,
	serializeResponse,
	VALID_COMMANDS,
	validateCommand,
} from "../../../src/lib/daemon/ipc-protocol.js";
import type { IPCCommand, IPCResponse } from "../../../src/lib/types.js";
import { generateSlug } from "../../../src/lib/utils.js";
import {
	directoryPath,
	edgeCaseString,
	invalidIPCCommand,
	invalidJSON,
	validIPCCommand,
} from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

describe("Ticket 3.2 — IPC Protocol PBT", () => {
	// ─── P1: parseCommand ─────────────────────────────────────────────────

	describe("P1: parseCommand handles valid/invalid JSON (AC2)", () => {
		it("property: valid command JSON parses correctly", () => {
			fc.assert(
				fc.property(validIPCCommand, (cmd) => {
					const json = JSON.stringify(cmd);
					const parsed = parseCommand(json);
					expect(parsed).not.toBeNull();
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
					expect(parsed!.cmd).toBe(cmd.cmd);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: invalid JSON returns null (never throws)", () => {
			fc.assert(
				fc.property(invalidJSON, (raw) => {
					const result = parseCommand(raw);
					// Should be null for anything that isn't { cmd: string, ... }
					if (result !== null) {
						expect(typeof result.cmd).toBe("string");
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: arbitrary strings never throw from parseCommand", () => {
			fc.assert(
				fc.property(edgeCaseString, (raw) => {
					// Must not throw
					const result = parseCommand(raw);
					expect(result === null || typeof result.cmd === "string").toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: serializeResponse ────────────────────────────────────────────

	describe("P2: serializeResponse produces valid JSON + newline (AC2)", () => {
		it("property: serialized response ends with newline and is valid JSON", () => {
			const arbResponse: fc.Arbitrary<IPCResponse> = fc.oneof(
				fc.record({ ok: fc.constant(true) }),
				fc.record({ ok: fc.constant(false), error: fc.string() }),
				fc.record({
					ok: fc.constant(true),
					slug: fc.string(),
					projects: fc.array(
						fc.record({ slug: fc.string(), directory: fc.string() }),
					),
				}),
			) as fc.Arbitrary<IPCResponse>;

			fc.assert(
				fc.property(arbResponse, (response) => {
					const serialized = serializeResponse(response);
					expect(serialized.endsWith("\n")).toBe(true);

					// Should be valid JSON (without trailing newline)
					const parsed = JSON.parse(serialized.trimEnd());
					expect(parsed.ok).toBe(response.ok);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: validateCommand ──────────────────────────────────────────────

	describe("P3: validateCommand returns null for valid, error for invalid (AC6)", () => {
		it("property: valid commands pass validation (return null)", () => {
			fc.assert(
				fc.property(validIPCCommand, (cmd) => {
					const error = validateCommand(cmd);
					expect(error).toBeNull();
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: commands with invalid cmd field return error", () => {
			fc.assert(
				fc.property(invalidIPCCommand, (cmd) => {
					if (!VALID_COMMANDS.has(cmd.cmd)) {
						const error = validateCommand(cmd);
						expect(error).not.toBeNull();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(error!.ok).toBe(false);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(typeof error!.error).toBe("string");
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P4: Unknown commands ─────────────────────────────────────────────

	describe("P4: Unknown commands produce structured error (AC6)", () => {
		it("property: unknown cmd → error contains the command name", () => {
			fc.assert(
				fc.property(
					fc
						.string({ minLength: 1, maxLength: 30 })
						.filter((s) => !VALID_COMMANDS.has(s)),
					(cmdName) => {
						const error = validateCommand({ cmd: cmdName } as IPCCommand &
							Record<string, unknown>);
						expect(error).not.toBeNull();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(error!.error).toContain(cmdName);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P5: generateSlug ─────────────────────────────────────────────────

	describe("P5: generateSlug produces unique, non-empty, lowercase slugs (AC3)", () => {
		it("property: slug is always non-empty and lowercase", () => {
			fc.assert(
				fc.property(directoryPath, (dir) => {
					const slug = generateSlug(dir, new Set());
					expect(slug.length).toBeGreaterThan(0);
					expect(slug).toBe(slug.toLowerCase());
					expect(slug).toMatch(/^[a-z0-9-]+$/);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: slug is unique among existing slugs", () => {
			fc.assert(
				fc.property(
					directoryPath,
					fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
						minLength: 0,
						maxLength: 10,
					}),
					(dir, existingList) => {
						const existing = new Set(existingList);
						const slug = generateSlug(dir, existing);
						expect(existing.has(slug)).toBe(false);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: generating N slugs from same dir with accumulating set always unique", () => {
			fc.assert(
				fc.property(
					directoryPath,
					fc.integer({ min: 2, max: 20 }),
					(dir, count) => {
						const slugs = new Set<string>();
						for (let i = 0; i < count; i++) {
							const slug = generateSlug(dir, slugs);
							expect(slugs.has(slug)).toBe(false);
							slugs.add(slug);
						}
						expect(slugs.size).toBe(count);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P6: JSON-lines roundtrip ─────────────────────────────────────────

	describe("P6: Serialize→parse roundtrip preserves data (AC2)", () => {
		it("property: response survives serialize→parse roundtrip", () => {
			fc.assert(
				fc.property(
					fc.record({
						ok: fc.boolean(),
						error: fc.oneof(fc.constant(undefined), fc.string()),
						slug: fc.oneof(fc.constant(undefined), fc.string()),
					}),
					(response) => {
						const clean: IPCResponse = { ok: response.ok };
						if (response.error !== undefined) clean.error = response.error;
						if (response.slug !== undefined) clean.slug = response.slug;

						const serialized = serializeResponse(clean);
						const parsed = JSON.parse(serialized.trimEnd());
						expect(parsed.ok).toBe(clean.ok);
						if (clean.error !== undefined)
							expect(parsed.error).toBe(clean.error);
						if (clean.slug !== undefined) expect(parsed.slug).toBe(clean.slug);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── Ticket 8.7: restart_with_config command ──────────────────────────

	describe("Ticket 8.7: restart_with_config command", () => {
		it("restart_with_config is in VALID_COMMANDS", () => {
			expect(VALID_COMMANDS.has("restart_with_config")).toBe(true);
		});

		it("validateCommand accepts restart_with_config with no extra fields", () => {
			const result = validateCommand({ cmd: "restart_with_config" });
			expect(result).toBeNull();
		});

		it("parseCommand parses restart_with_config JSON", () => {
			const raw = JSON.stringify({ cmd: "restart_with_config" });
			const parsed = parseCommand(raw);
			expect(parsed).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(parsed!.cmd).toBe("restart_with_config");
		});

		it("command router dispatches restart_with_config to handler", async () => {
			let called = false;
			const router = createCommandRouter({
				addProject: async () => ({ ok: true }),
				removeProject: async () => ({ ok: true }),
				listProjects: async () => ({ ok: true }),
				setProjectTitle: async () => ({ ok: true }),
				getStatus: async () => ({ ok: true }),
				setPin: async () => ({ ok: true }),
				setKeepAwake: async () => ({ ok: true }),
				setKeepAwakeCommand: async () => ({ ok: true }),
				shutdown: async () => ({ ok: true }),
				setAgent: async () => ({ ok: true }),
				setModel: async () => ({ ok: true }),
				restartWithConfig: async () => {
					called = true;
					return { ok: true };
				},
				instanceList: async () => ({ ok: true }),
				instanceAdd: async () => ({ ok: true }),
				instanceRemove: async () => ({ ok: true }),
				instanceStart: async () => ({ ok: true }),
				instanceStop: async () => ({ ok: true }),
				instanceUpdate: async () => ({ ok: true }),
				instanceStatus: async () => ({ ok: true }),
			});

			const result = await router({ cmd: "restart_with_config" });
			expect(result.ok).toBe(true);
			expect(called).toBe(true);
		});

		it("VALID_COMMANDS now contains 19 commands", () => {
			expect(VALID_COMMANDS.size).toBe(19);
		});
	});

	// ─── Instance commands ────────────────────────────────────────────────

	describe("instance commands", () => {
		it("instance_list is a valid command with no required fields", () => {
			expect(VALID_COMMANDS.has("instance_list")).toBe(true);
			const result = validateCommand({ cmd: "instance_list" });
			expect(result).toBeNull();
		});

		it("instance_add requires name (non-empty string)", () => {
			const missing = validateCommand({ cmd: "instance_add", managed: true });
			expect(missing).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.error).toContain("name");

			const empty = validateCommand({
				cmd: "instance_add",
				name: "",
				managed: true,
			});
			expect(empty).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(empty!.ok).toBe(false);
		});

		it("instance_add requires managed (boolean)", () => {
			const missing = validateCommand({
				cmd: "instance_add",
				name: "test",
			});
			expect(missing).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.error).toContain("managed");
		});

		it("instance_add with valid fields passes validation", () => {
			const result = validateCommand({
				cmd: "instance_add",
				name: "my-instance",
				managed: true,
				port: 4096,
			});
			expect(result).toBeNull();
		});

		it("instance_add requires valid port for managed instances", () => {
			const noPort = validateCommand({
				cmd: "instance_add",
				name: "test",
				managed: true,
			});
			expect(noPort).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(noPort!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(noPort!.error).toContain("port");

			const zeroPort = validateCommand({
				cmd: "instance_add",
				name: "test",
				managed: true,
				port: 0,
			});
			expect(zeroPort).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(zeroPort!.ok).toBe(false);

			const highPort = validateCommand({
				cmd: "instance_add",
				name: "test",
				managed: true,
				port: 70000,
			});
			expect(highPort).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(highPort!.ok).toBe(false);
		});

		it("instance_add requires url or port for unmanaged instances", () => {
			const result = validateCommand({
				cmd: "instance_add",
				name: "external",
				managed: false,
			});
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.error).toContain("url");
		});

		it("instance_add with url passes validation for unmanaged instances", () => {
			const result = validateCommand({
				cmd: "instance_add",
				name: "external",
				managed: false,
				url: "http://host:4096",
			});
			expect(result).toBeNull();
		});

		it("instance_add with port but no url passes for unmanaged instances", () => {
			const result = validateCommand({
				cmd: "instance_add",
				name: "external",
				managed: false,
				port: 4096,
			});
			expect(result).toBeNull();
		});

		it("instance_add with empty url fails validation", () => {
			const result = validateCommand({
				cmd: "instance_add",
				name: "external",
				managed: false,
				url: "",
			});
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.error).toContain("url");
		});

		it("instance_add with non-string url fails validation", () => {
			const result = validateCommand({
				cmd: "instance_add",
				name: "external",
				managed: false,
				url: 123,
			});
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.ok).toBe(false);
		});

		it("instance_add with url is rejected for managed instances", () => {
			// url is only valid for unmanaged instances
			const result = validateCommand({
				cmd: "instance_add",
				name: "managed-with-url",
				managed: true,
				port: 4097,
				url: "http://host:4097",
			});
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.error).toContain("url");
		});

		it("instance_remove requires id (non-empty string)", () => {
			const missing = validateCommand({ cmd: "instance_remove" });
			expect(missing).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.error).toContain("id");

			const empty = validateCommand({ cmd: "instance_remove", id: "" });
			expect(empty).not.toBeNull();
		});

		it("instance_start requires id (non-empty string)", () => {
			const missing = validateCommand({ cmd: "instance_start" });
			expect(missing).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.error).toContain("id");
		});

		it("instance_stop requires id (non-empty string)", () => {
			const missing = validateCommand({ cmd: "instance_stop" });
			expect(missing).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.error).toContain("id");
		});

		it("instance_status requires id (non-empty string)", () => {
			const missing = validateCommand({ cmd: "instance_status" });
			expect(missing).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.ok).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(missing!.error).toContain("id");
		});
	});

	describe("slug generation sanitization", () => {
		// Tests the pattern used in daemon-ipc.ts instanceAdd
		function slugify(name: string): string {
			return (
				name
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-")
					.replace(/-+/g, "-")
					.replace(/^-|-$/g, "") || "instance"
			);
		}

		it("produces clean slug from normal name", () => {
			expect(slugify("My Work")).toBe("my-work");
		});

		it("collapses consecutive dashes", () => {
			expect(slugify("a---b")).toBe("a-b");
			expect(slugify("test!!name")).toBe("test-name");
		});

		it("trims leading and trailing dashes", () => {
			expect(slugify("--test--")).toBe("test");
			expect(slugify("!hello!")).toBe("hello");
		});

		it("falls back to 'instance' for empty result", () => {
			expect(slugify("!!!")).toBe("instance");
			expect(slugify("")).toBe("instance");
		});

		it("handles unicode names", () => {
			expect(slugify("café")).toBe("caf");
			// Entirely non-ascii
			expect(slugify("日本語")).toBe("instance");
		});
	});

	// ─── IPC fuzz testing ────────────────────────────────────────────────────

	describe("IPC fuzz testing", () => {
		it("parseCommand never throws on arbitrary strings", () => {
			fc.assert(
				fc.property(fc.string(), (raw) => {
					const result = parseCommand(raw);
					// Should return IPCCommand or null, never throw
					expect(result === null || typeof result === "object").toBe(true);
				}),
				{ numRuns: 1000, seed: SEED },
			);
		});

		it("validateCommand never throws on arbitrary objects", () => {
			fc.assert(
				fc.property(
					fc.record({
						cmd: fc.oneof(
							fc.constantFrom(...VALID_COMMANDS),
							fc.string(),
							fc.constant(undefined),
						),
						name: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
						port: fc.oneof(
							fc.integer(),
							fc.string(),
							fc.constant(undefined),
							fc.constant(-1),
							fc.constant(0),
							fc.constant(99999),
						),
						managed: fc.oneof(
							fc.boolean(),
							fc.string(),
							fc.constant(undefined),
						),
						id: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
						url: fc.oneof(fc.string(), fc.constant(undefined)),
					}),
					(obj) => {
						const result = validateCommand(
							obj as unknown as import("../../../src/lib/types.js").IPCCommand,
						);
						// Should return null (valid) or an error response, never throw
						expect(
							result === null || (typeof result === "object" && "ok" in result),
						).toBe(true);
					},
				),
				{ numRuns: 1000, seed: SEED },
			);
		});

		it("validateCommand returns well-formed errors for all instance commands with missing fields", () => {
			const instanceCmds = [
				"instance_add",
				"instance_remove",
				"instance_start",
				"instance_stop",
				"instance_status",
			];

			for (const cmd of instanceCmds) {
				// Missing all required fields
				const result = validateCommand({ cmd });
				expect(result).not.toBeNull();
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.ok).toBe(false);
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(typeof result!.error).toBe("string");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect((result!.error as string).length).toBeGreaterThan(0);
			}
		});
	});
});
