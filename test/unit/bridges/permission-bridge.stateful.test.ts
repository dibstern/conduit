// ─── State-Machine Model Test: Permission Bridge (Ticket 1.5) ───────────────
//
// Uses fc.commands() + fc.modelRun() to exercise arbitrary interleavings of:
//   - AddPermission (SSE permission.asked arrives)
//   - RespondPermission (browser sends decision)
//   - CLIReply (permission.replied SSE from OpenCode CLI)
//   - CheckTimeout (time advances, expired permissions auto-denied)
//   - Recover (crash recovery — fetch pending from REST)
//
// Model: simple Map<requestId, { toolName, timestamp }>
// Real: PermissionBridge instance
//
// This catches ordering bugs, double-free issues, stale state after recovery, etc.

import fc from "fast-check";
import { describe, it } from "vitest";
import { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import type {
	FrontendDecision,
	OpenCodeEvent,
} from "../../../src/lib/types.js";

const SEED = 42;
const NUM_RUNS = 100;

// ─── Model (reference implementation) ───────────────────────────────────────

interface ModelState {
	pending: Map<string, { toolName: string; timestamp: number }>;
	time: number;
}

// ─── Commands ───────────────────────────────────────────────────────────────

type RealState = { bridge: PermissionBridge; time: number };

class AddPermissionCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly id: string,
		readonly toolName: string,
	) {}

	check(model: Readonly<ModelState>): boolean {
		// Only add if ID not already pending (avoid confusing model)
		return !model.pending.has(this.id) && this.id.length > 0;
	}

	run(model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: { id: this.id, permission: this.toolName },
		};

		const realResult = real.bridge.onPermissionRequest(event);

		// Model: add to pending
		model.pending.set(this.id, {
			toolName: this.toolName,
			timestamp: model.time,
		});
		// Real: should return the entry
		if (realResult === null) {
			throw new Error(`Expected pending entry for "${this.id}" but got null`);
		}
		if (realResult.requestId !== this.id) {
			throw new Error(
				`Expected requestId "${this.id}" but got "${realResult.requestId}"`,
			);
		}

		// Size invariant
		if (real.bridge.size !== model.pending.size) {
			throw new Error(
				`Size mismatch: model=${model.pending.size}, real=${real.bridge.size}`,
			);
		}
	}

	toString(): string {
		return `AddPermission(${this.id}, ${this.toolName})`;
	}
}

class RespondPermissionCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly id: string,
		readonly decision: FrontendDecision,
	) {}

	check(_model: Readonly<ModelState>): boolean {
		return true; // Always valid — tests duplicate/unknown handling too
	}

	run(model: ModelState, real: RealState): void {
		const wasPending = model.pending.has(this.id);
		const realResult = real.bridge.onPermissionResponse(this.id, this.decision);

		if (wasPending) {
			// Model: remove from pending
			model.pending.delete(this.id);

			// Real: should return mapped decision
			if (realResult === null) {
				throw new Error(
					`Expected response for pending "${this.id}" but got null`,
				);
			}
		} else {
			// Model: was not pending (duplicate or unknown)
			// Real: should return null
			if (realResult !== null) {
				throw new Error(
					`Expected null for non-pending "${this.id}" but got result`,
				);
			}
		}

		// Size invariant
		if (real.bridge.size !== model.pending.size) {
			throw new Error(
				`Size mismatch after respond: model=${model.pending.size}, real=${real.bridge.size}`,
			);
		}
	}

	toString(): string {
		return `RespondPermission(${this.id}, ${this.decision})`;
	}
}

class CLIReplyCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly id: string) {}

	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		const wasPending = model.pending.has(this.id);
		model.pending.delete(this.id);

		const realRemoved = real.bridge.onPermissionReplied(this.id);

		if (wasPending !== realRemoved) {
			throw new Error(
				`CLIReply mismatch for "${this.id}": model wasPending=${wasPending}, real removed=${realRemoved}`,
			);
		}

		if (real.bridge.size !== model.pending.size) {
			throw new Error(
				`Size mismatch after CLI reply: model=${model.pending.size}, real=${real.bridge.size}`,
			);
		}
	}

	toString(): string {
		return `CLIReply(${this.id})`;
	}
}

class CheckTimeoutCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly advanceMs: number) {}

	check(_model: Readonly<ModelState>): boolean {
		return this.advanceMs > 0;
	}

	run(model: ModelState, real: RealState): void {
		// Advance time
		model.time += this.advanceMs;
		real.time += this.advanceMs;

		// Model: remove entries older than timeoutMs (5 minutes = 300_000ms)
		const TIMEOUT = 300_000;
		const modelTimedOut: string[] = [];
		for (const [id, entry] of model.pending) {
			if (model.time - entry.timestamp >= TIMEOUT) {
				modelTimedOut.push(id);
				model.pending.delete(id);
			}
		}

		const realTimedOut = real.bridge.checkTimeouts();

		// Compare sets (order doesn't matter)
		const modelSet = new Set(modelTimedOut);
		const realSet = new Set(realTimedOut);

		if (modelSet.size !== realSet.size) {
			throw new Error(
				`Timeout count mismatch: model=${modelSet.size}, real=${realSet.size}`,
			);
		}

		for (const id of modelSet) {
			if (!realSet.has(id)) {
				throw new Error(`Model timed out "${id}" but real didn't`);
			}
		}

		if (real.bridge.size !== model.pending.size) {
			throw new Error(
				`Size mismatch after timeout: model=${model.pending.size}, real=${real.bridge.size}`,
			);
		}
	}

	toString(): string {
		return `CheckTimeout(+${this.advanceMs}ms)`;
	}
}

class RecoverCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly permissions: Array<{ id: string; permission: string }>,
	) {}

	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		// Model: add all to pending (unique IDs only)
		for (const p of this.permissions) {
			if (p.id.length > 0) {
				model.pending.set(p.id, {
					toolName: p.permission,
					timestamp: model.time,
				});
			}
		}

		// Real: recover
		const validPerms = this.permissions.filter((p) => p.id.length > 0);
		real.bridge.recoverPending(validPerms);

		if (real.bridge.size !== model.pending.size) {
			throw new Error(
				`Size mismatch after recover: model=${model.pending.size}, real=${real.bridge.size}`,
			);
		}
	}

	toString(): string {
		return `Recover(${this.permissions.length} perms)`;
	}
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbId = fc.oneof(
	{ weight: 5, arbitrary: fc.uuid() },
	{ weight: 3, arbitrary: fc.stringMatching(/^[a-z0-9]{4,12}$/) },
);

const arbToolName = fc.constantFrom(
	"bash",
	"read",
	"edit",
	"write",
	"glob",
	"grep",
	"external_directory",
);

const arbDecision: fc.Arbitrary<FrontendDecision> = fc.constantFrom(
	"allow",
	"deny",
	"allow_always",
);

const allCommands = fc.commands(
	[
		// AddPermission — fresh ID + tool
		fc
			.tuple(arbId, arbToolName)
			.map(([id, tool]) => new AddPermissionCommand(id, tool)),

		// RespondPermission — any ID (may be pending or not) + decision
		fc
			.tuple(arbId, arbDecision)
			.map(([id, d]) => new RespondPermissionCommand(id, d)),

		// CLIReply — any ID
		arbId.map((id) => new CLIReplyCommand(id)),

		// CheckTimeout — advance time by 0–400s
		fc
			.integer({ min: 1, max: 400_000 })
			.map((ms) => new CheckTimeoutCommand(ms)),

		// Recover — small batch of permissions
		fc
			.array(fc.record({ id: arbId, permission: arbToolName }), {
				minLength: 0,
				maxLength: 5,
			})
			.map((perms) => new RecoverCommand(perms)),
	],
	{ maxCommands: 30 },
);

// ─── Test ───────────────────────────────────────────────────────────────────

describe("Ticket 1.5 — Permission Bridge State Machine PBT", () => {
	it("property: arbitrary command sequences maintain model/real consistency", () => {
		fc.assert(
			fc.property(allCommands, (cmds) => {
				const time = 1_000_000;

				const model: ModelState = {
					pending: new Map(),
					time,
				};

				const real: RealState = {
					bridge: new PermissionBridge({
						timeoutMs: 300_000, // 5 minutes
						now: () => real.time,
					}),
					time,
				};

				fc.modelRun(() => ({ model, real }), cmds);
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});
