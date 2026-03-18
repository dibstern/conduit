// ─── Property-Based Tests: Permission Bridge (Ticket 1.5) ───────────────────
//
// Properties tested:
// P1: Decision mapping is bijective: frontend→OC→frontend roundtrips (AC2, AC3)
// P2: All valid frontend decisions map to valid OC decisions (AC3)
// P3: Invalid decisions produce null (safety)
// P4: Pending map: add then respond = empty; add then respond same ID = idempotent (AC8)
// P5: Duplicate responses are ignored (AC8)
// P6: "always" decisions map correctly but do not cache (no auto-approve)
// P7: Timeout removes expired permissions (AC5)
// P8: Recovery populates pending map correctly (AC9)
// P9: Concurrent permissions tracked independently (AC6)
// P10: CLI-replied permissions are removed from pending (AC10)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	mapDecision,
	mapDecisionReverse,
	PermissionBridge,
} from "../../../src/lib/bridges/permission-bridge.js";
import type {
	FrontendDecision,
	OpenCodeDecision,
	OpenCodeEvent,
} from "../../../src/lib/types.js";
import {
	anyToolName,
	frontendDecision,
	idString,
	invalidDecision,
	openCodeDecision,
} from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

describe("Ticket 1.5 — Permission Bridge PBT", () => {
	// ─── P1: Decision mapping roundtrip ───────────────────────────────────

	describe("P1: Decision mapping roundtrips (AC2, AC3)", () => {
		it("property: frontend→OC→frontend is identity for valid decisions", () => {
			fc.assert(
				fc.property(frontendDecision, (fd) => {
					const oc = mapDecision(fd);
					expect(oc).not.toBeNull();
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
					const back = mapDecisionReverse(oc!);
					expect(back).toBe(fd);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: OC→frontend→OC is identity for valid decisions", () => {
			fc.assert(
				fc.property(openCodeDecision, (od) => {
					const fd = mapDecisionReverse(od);
					expect(fd).not.toBeNull();
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
					const back = mapDecision(fd!);
					expect(back).toBe(od);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: All valid decisions map correctly ────────────────────────────

	describe("P2: Concrete mappings: allow→once, deny→reject, allow_always→always (AC3)", () => {
		it("property: all three frontend→OC mappings hold", () => {
			const expected: Record<FrontendDecision, OpenCodeDecision> = {
				allow: "once",
				deny: "reject",
				allow_always: "always",
			};

			fc.assert(
				fc.property(frontendDecision, (fd) => {
					expect(mapDecision(fd)).toBe(expected[fd]);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: Invalid decisions → null ─────────────────────────────────────

	describe("P3: Invalid decisions produce null (safety)", () => {
		it("property: arbitrary invalid strings → null from mapDecision", () => {
			fc.assert(
				fc.property(invalidDecision, (d) => {
					if (d !== "allow" && d !== "deny" && d !== "allow_always") {
						expect(mapDecision(d)).toBeNull();
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P4: Pending map add/respond lifecycle ────────────────────────────

	describe("P4: add→respond = empty pending map (AC2)", () => {
		it("property: adding and responding removes from pending", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					frontendDecision,
					(id, toolName, decision) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						const event: OpenCodeEvent = {
							type: "permission.asked",
							properties: {
								id,
								permission: toolName,
								sessionID: "test-session",
							},
						};

						bridge.onPermissionRequest(event);
						expect(bridge.size).toBe(1);

						const result = bridge.onPermissionResponse(id, decision);
						expect(result).not.toBeNull();
						expect(bridge.size).toBe(0);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P5: Duplicate responses are ignored ──────────────────────────────

	describe("P5: Duplicate responses are ignored (AC8)", () => {
		it("property: second response to same ID returns null", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					frontendDecision,
					frontendDecision,
					(id, toolName, decision1, decision2) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						bridge.onPermissionRequest({
							type: "permission.asked",
							properties: {
								id,
								permission: toolName,
								sessionID: "test-session",
							},
						});

						const first = bridge.onPermissionResponse(id, decision1);
						expect(first).not.toBeNull();

						const second = bridge.onPermissionResponse(id, decision2);
						expect(second).toBeNull(); // Duplicate ignored
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P6: "always" maps correctly but does not auto-approve ──────────

	describe("P6: allow_always maps to 'always' but no auto-approve cache (AC4)", () => {
		it("property: after allow_always, onPermissionResponse returns { mapped: 'always', toolName } and next request for same tool creates a new PendingPermission", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					idString.filter((s) => s.length > 0),
					anyToolName,
					(id1, id2Seed, toolName) => {
						// Ensure distinct IDs
						const id2 = id2Seed === id1 ? `${id2Seed}_2` : id2Seed;

						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						bridge.onPermissionRequest({
							type: "permission.asked",
							properties: {
								id: id1,
								permission: toolName,
								sessionID: "test-session",
							},
						});

						const result = bridge.onPermissionResponse(id1, "allow_always");
						expect(result).not.toBeNull();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(result!.mapped).toBe("always");
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(result!.toolName).toBe(toolName);

						// Next request for the SAME tool should still create a PendingPermission (no cache)
						const entry = bridge.onPermissionRequest({
							type: "permission.asked",
							properties: {
								id: id2,
								permission: toolName,
								sessionID: "test-session",
							},
						});
						expect(entry).not.toBeNull();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(entry!.requestId).toBe(id2);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(entry!.toolName).toBe(toolName);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P7: Timeout removes expired permissions ─────────────────────────

	describe("P7: Timeout removes expired permissions (AC5)", () => {
		it("property: permissions older than timeoutMs are removed by checkTimeouts", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							id: idString.filter((s) => s.length > 0),
							tool: anyToolName,
						}),
						{ minLength: 1, maxLength: 10 },
					),
					fc.integer({ min: 1000, max: 600_000 }),
					(entries, timeoutMs) => {
						let time = 1_000_000;
						const bridge = new PermissionBridge({ timeoutMs, now: () => time });

						// Use unique IDs
						const uniqueEntries = entries.filter(
							(e, i) => entries.findIndex((x) => x.id === e.id) === i,
						);

						for (const entry of uniqueEntries) {
							bridge.onPermissionRequest({
								type: "permission.asked",
								properties: {
									id: entry.id,
									permission: entry.tool,
									sessionID: "test-session",
								},
							});
						}

						// Before timeout: nothing removed
						const beforeTimeout = bridge.checkTimeouts();
						expect(beforeTimeout).toHaveLength(0);

						// After timeout: all removed
						time += timeoutMs + 1;
						const afterTimeout = bridge.checkTimeouts();
						expect(afterTimeout).toHaveLength(uniqueEntries.length);
						expect(bridge.size).toBe(0);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P8: Recovery populates pending map ───────────────────────────────

	describe("P8: Recovery populates pending map (AC9)", () => {
		it("property: recoverPending fills map with all provided permissions", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							id: idString.filter((s) => s.length > 0),
							permission: anyToolName,
						}),
						{ minLength: 0, maxLength: 10 },
					),
					(permissions) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						// Ensure unique IDs
						const unique = permissions.filter(
							(p, i) => permissions.findIndex((x) => x.id === p.id) === i,
						);

						const recovered = bridge.recoverPending(
							unique.map((p) => ({ ...p, sessionId: "recovered-session" })),
						);
						expect(recovered).toHaveLength(unique.length);
						expect(bridge.size).toBe(unique.length);

						// All recovered entries should be gettable via getPending
						const pending = bridge.getPending();
						for (const p of unique) {
							const pp = pending.find((pp) => pp.requestId === p.id);
							expect(pp).toBeDefined();
							// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
							expect(pp!.sessionId).toBe("recovered-session");
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P9: Concurrent permissions tracked independently ─────────────────

	describe("P9: Multiple pending permissions tracked independently (AC6)", () => {
		it("property: N different permissions can coexist and be resolved independently", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							id: idString.filter((s) => s.length > 0),
							tool: anyToolName,
						}),
						{ minLength: 2, maxLength: 8 },
					),
					frontendDecision,
					(entries, decision) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						// Ensure unique IDs
						const unique = entries.filter(
							(e, i) => entries.findIndex((x) => x.id === e.id) === i,
						);
						if (unique.length < 2) return; // Need at least 2

						for (const entry of unique) {
							bridge.onPermissionRequest({
								type: "permission.asked",
								properties: {
									id: entry.id,
									permission: entry.tool,
									sessionID: "test-session",
								},
							});
						}

						expect(bridge.size).toBe(unique.length);

						// Resolve first one
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						bridge.onPermissionResponse(unique[0]!.id, decision);
						expect(bridge.size).toBe(unique.length - 1);

						// Others still pending
						for (let i = 1; i < unique.length; i++) {
							const pending = bridge.getPending();
							expect(
								// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
								pending.find((p) => p.requestId === unique[i]!.id),
							).toBeDefined();
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P10: CLI-replied permissions removed ─────────────────────────────

	describe("P10: CLI-replied permissions removed from pending (AC10)", () => {
		it("property: onPermissionReplied removes the permission", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					(id, toolName) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						bridge.onPermissionRequest({
							type: "permission.asked",
							properties: {
								id,
								permission: toolName,
								sessionID: "test-session",
							},
						});

						expect(bridge.size).toBe(1);

						const removed = bridge.onPermissionReplied(id);
						expect(removed).toBe(true);
						expect(bridge.size).toBe(0);

						// Second call returns false (already removed)
						const removedAgain = bridge.onPermissionReplied(id);
						expect(removedAgain).toBe(false);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P11: sessionId is stored and retrievable ────────────────────────

	describe("P11: sessionId is stored and retrievable", () => {
		it("property: onPermissionRequest stores sessionId from event", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					idString,
					(id, toolName, sessionId) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						const entry = bridge.onPermissionRequest({
							type: "permission.asked",
							properties: { id, permission: toolName, sessionID: sessionId },
						});

						expect(entry).not.toBeNull();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(entry!.sessionId).toBe(sessionId);

						const pending = bridge.getPending();
						expect(pending).toHaveLength(1);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior length assertion
						expect(pending[0]!.sessionId).toBe(sessionId);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: onPermissionRequest defaults sessionId to empty string when missing", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					(id, toolName) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						const entry = bridge.onPermissionRequest({
							type: "permission.asked",
							properties: { id, permission: toolName },
						});

						expect(entry).not.toBeNull();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(entry!.sessionId).toBe("");
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: recoverPending stores sessionId from permissions", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					idString,
					(id, toolName, sessionId) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						const recovered = bridge.recoverPending([
							{ id, permission: toolName, sessionId },
						]);

						expect(recovered).toHaveLength(1);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior length assertion
						expect(recovered[0]!.sessionId).toBe(sessionId);

						const pending = bridge.getPending();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior length assertion
						expect(pending[0]!.sessionId).toBe(sessionId);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: recoverPending defaults sessionId to empty string when missing", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					(id, toolName) => {
						const bridge = new PermissionBridge({ now: () => 1_000_000 });

						const recovered = bridge.recoverPending([
							{ id, permission: toolName },
						]);

						expect(recovered).toHaveLength(1);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior length assertion
						expect(recovered[0]!.sessionId).toBe("");
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
