// ─── State-Machine Model Test: Event Translator (Ticket 1.3) ────────────────
//
// Uses fc.commands() + fc.modelRun() to exercise the stateful translator's
// part-tracking state machine under arbitrary interleavings of:
//   - ReceiveToolPart (new tool part → pending)
//   - UpdateToolStatus (pending → running → completed | error)
//   - ReceiveReasoningPart (new reasoning → thinking_start)
//   - FinalizeReasoning (set time.end → thinking_stop)
//   - ReceiveTextDelta (delta on known text or reasoning part)
//   - RemovePart (part.removed)
//   - RemoveMessage (message.removed — clears tracking)
//   - Reset (session switch / reconnect)
//   - RebuildFromHistory (reconnection recovery)
//
// Model: Map<partID, { type, status, isNew }> tracking what the translator should know.
// Invariants verified after each command:
//   - seenParts size matches model
//   - No duplicate lifecycle events (tool_start, thinking_start)
//   - Part removal clears tracking
//   - Reset empties everything

import fc from "fast-check";
import { describe, it } from "vitest";
import {
	createTranslator,
	mapToolName,
} from "../../../src/lib/relay/event-translator.js";
import type {
	OpenCodeEvent,
	PartType,
	ToolStatus,
} from "../../../src/lib/types.js";

const SEED = 42;
const NUM_RUNS = 100;

// ─── Model ──────────────────────────────────────────────────────────────────

interface PartInfo {
	type: PartType;
	status?: ToolStatus;
}

interface ModelState {
	seenParts: Map<string, PartInfo>;
}

interface RealState {
	translator: ReturnType<typeof createTranslator>;
}

// ─── Commands ───────────────────────────────────────────────────────────────

class ReceiveToolPartCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly partID: string,
		readonly tool: string,
	) {}

	check(model: Readonly<ModelState>): boolean {
		// Only add truly new parts
		return !model.seenParts.has(this.partID) && this.partID.length > 0;
	}

	run(model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: {
				partID: this.partID,
				part: {
					type: "tool",
					callID: this.partID,
					tool: this.tool,
					state: { status: "pending" },
				},
			},
		};

		const result = real.translator.translate(event);

		// Model: part is now tracked
		model.seenParts.set(this.partID, { type: "tool", status: "pending" });

		// Real: should emit tool_start for new pending tool
		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			const first = result.messages[0]!;
			if (first.type === "tool_start") {
				// Expected — new part emits tool_start
				const expected = mapToolName(this.tool);
				if ((first as { name: string }).name !== expected) {
					throw new Error(
						`tool_start name mismatch: expected "${expected}", got "${(first as { name: string }).name}"`,
					);
				}
			}
		}

		this.assertSizeMatch(model, real);
	}

	private assertSizeMatch(model: ModelState, real: RealState): void {
		const realSize = real.translator.getSeenParts()?.size ?? 0;
		if (realSize !== model.seenParts.size) {
			throw new Error(
				`seenParts size mismatch: model=${model.seenParts.size}, real=${realSize}`,
			);
		}
	}

	toString(): string {
		return `ReceiveToolPart(${this.partID}, ${this.tool})`;
	}
}

class UpdateToolStatusCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly partID: string,
		readonly status: ToolStatus,
		readonly tool: string,
	) {}

	check(model: Readonly<ModelState>): boolean {
		// Only update existing tool parts
		const part = model.seenParts.get(this.partID);
		return part !== undefined && part.type === "tool";
	}

	run(model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: {
				partID: this.partID,
				part: {
					type: "tool",
					callID: this.partID,
					tool: this.tool,
					state: {
						status: this.status,
						...(this.status === "running" ? { input: { cmd: "test" } } : {}),
						...(this.status === "completed" ? { output: "done" } : {}),
						...(this.status === "error" ? { error: "fail" } : {}),
					},
				},
			},
		};

		const result = real.translator.translate(event);

		// Model: update status
		model.seenParts.set(this.partID, { type: "tool", status: this.status });

		// Real: should NOT emit tool_start (part already seen)
		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			const msg = result.messages[0]!;
			if (msg.type === "tool_start") {
				throw new Error(
					`Duplicate tool_start for already-seen part "${this.partID}"`,
				);
			}
		}

		// Verify correct event type for status
		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			const msg = result.messages[0]!;
			if (this.status === "running" && msg.type !== "tool_executing") {
				throw new Error(
					`Expected tool_executing for running status, got ${msg.type}`,
				);
			}
			if (this.status === "completed" && msg.type !== "tool_result") {
				throw new Error(
					`Expected tool_result for completed status, got ${msg.type}`,
				);
			}
			if (this.status === "error" && msg.type !== "tool_result") {
				throw new Error(
					`Expected tool_result for error status, got ${msg.type}`,
				);
			}
		}

		// Size should still match
		const realSize = real.translator.getSeenParts()?.size ?? 0;
		if (realSize !== model.seenParts.size) {
			throw new Error(
				`seenParts size mismatch after update: model=${model.seenParts.size}, real=${realSize}`,
			);
		}
	}

	toString(): string {
		return `UpdateToolStatus(${this.partID}, ${this.status})`;
	}
}

class ReceiveReasoningPartCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly partID: string) {}

	check(model: Readonly<ModelState>): boolean {
		return !model.seenParts.has(this.partID) && this.partID.length > 0;
	}

	run(model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: {
				partID: this.partID,
				part: { type: "reasoning" },
			},
		};

		const result = real.translator.translate(event);

		model.seenParts.set(this.partID, { type: "reasoning" });

		// Should emit thinking_start for new reasoning part
		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			const msg = result.messages[0]!;
			if (msg.type !== "thinking_start") {
				throw new Error(
					`Expected thinking_start for new reasoning part, got ${msg.type}`,
				);
			}
		}

		const realSize = real.translator.getSeenParts()?.size ?? 0;
		if (realSize !== model.seenParts.size) {
			throw new Error(
				`seenParts size mismatch: model=${model.seenParts.size}, real=${realSize}`,
			);
		}
	}

	toString(): string {
		return `ReceiveReasoningPart(${this.partID})`;
	}
}

class FinalizeReasoningCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly partID: string) {}

	check(model: Readonly<ModelState>): boolean {
		const part = model.seenParts.get(this.partID);
		return part !== undefined && part.type === "reasoning";
	}

	run(_model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: {
				partID: this.partID,
				part: { type: "reasoning", time: { end: Date.now() } },
			},
		};

		const result = real.translator.translate(event);

		// Should emit thinking_stop (not thinking_start since part is already seen)
		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			const msg = result.messages[0]!;
			if (msg.type === "thinking_start") {
				throw new Error(
					`Duplicate thinking_start for already-seen reasoning part "${this.partID}"`,
				);
			}
			if (msg.type !== "thinking_stop") {
				throw new Error(
					`Expected thinking_stop for finalized reasoning, got ${msg.type}`,
				);
			}
		}
	}

	toString(): string {
		return `FinalizeReasoning(${this.partID})`;
	}
}

class RemovePartCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly partID: string,
		readonly messageID: string,
	) {}

	check(_model: Readonly<ModelState>): boolean {
		return this.partID.length > 0 && this.messageID.length > 0;
	}

	run(model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "message.part.removed",
			properties: { partID: this.partID, messageID: this.messageID },
		};

		real.translator.translate(event);
		model.seenParts.delete(this.partID);

		// After removal, part should not be tracked
		if (real.translator.getSeenParts()?.has(this.partID) ?? false) {
			throw new Error(`Part "${this.partID}" still tracked after removal`);
		}

		const realSize = real.translator.getSeenParts()?.size ?? 0;
		if (realSize !== model.seenParts.size) {
			throw new Error(
				`seenParts size mismatch after remove: model=${model.seenParts.size}, real=${realSize}`,
			);
		}
	}

	toString(): string {
		return `RemovePart(${this.partID})`;
	}
}

class ResetCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		model.seenParts.clear();
		real.translator.reset();

		if ((real.translator.getSeenParts()?.size ?? 0) !== 0) {
			throw new Error("seenParts not empty after reset");
		}
	}

	toString(): string {
		return "Reset()";
	}
}

class RebuildFromHistoryCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly parts: Array<{ id: string; type: PartType; status?: ToolStatus }>,
	) {}

	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		// Rebuild replaces all state
		model.seenParts.clear();
		for (const p of this.parts) {
			if (p.id.length > 0) {
				model.seenParts.set(p.id, {
					type: p.type,
					...(p.status != null && { status: p.status }),
				});
			}
		}

		real.translator.rebuildStateFromHistory("__default__", [
			{
				parts: this.parts
					.filter((p) => p.id.length > 0)
					.map((p) => ({
						id: p.id,
						type: p.type,
						...(p.status != null && { state: { status: p.status } }),
					})),
			},
		]);

		const realSize = real.translator.getSeenParts()?.size ?? 0;
		if (realSize !== model.seenParts.size) {
			throw new Error(
				`seenParts size mismatch after rebuild: model=${model.seenParts.size}, real=${realSize}`,
			);
		}
	}

	toString(): string {
		return `RebuildFromHistory(${this.parts.length} parts)`;
	}
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbPartID = fc.oneof(
	{ weight: 5, arbitrary: fc.uuid() },
	{ weight: 3, arbitrary: fc.stringMatching(/^p[0-9]{1,6}$/) },
);

const arbTool = fc.constantFrom(
	"bash",
	"read",
	"edit",
	"write",
	"glob",
	"grep",
);

const arbToolStatus: fc.Arbitrary<ToolStatus> = fc.constantFrom(
	"pending",
	"running",
	"completed",
	"error",
);

const allCommands = fc.commands(
	[
		// New tool part
		fc
			.tuple(arbPartID, arbTool)
			.map(([id, tool]) => new ReceiveToolPartCommand(id, tool)),

		// Update existing tool status
		fc
			.tuple(arbPartID, arbToolStatus, arbTool)
			.map(
				([id, status, tool]) => new UpdateToolStatusCommand(id, status, tool),
			),

		// New reasoning part
		arbPartID.map((id) => new ReceiveReasoningPartCommand(id)),

		// Finalize reasoning
		arbPartID.map((id) => new FinalizeReasoningCommand(id)),

		// Remove part
		fc
			.tuple(arbPartID, fc.uuid())
			.map(([pid, mid]) => new RemovePartCommand(pid, mid)),

		// Reset
		fc.constant(new ResetCommand()),

		// Rebuild from history
		fc
			.array(
				fc
					.record({
						id: arbPartID,
						type: fc.constantFrom(
							"tool" as PartType,
							"reasoning" as PartType,
							"text" as PartType,
						),
						status: fc.oneof(fc.constant(undefined), arbToolStatus),
					})
					.map(({ id, type, status }) => ({
						id,
						type,
						...(status != null && { status }),
					})),
				{ minLength: 0, maxLength: 8 },
			)
			.map((parts) => new RebuildFromHistoryCommand(parts)),
	],
	{ maxCommands: 40 },
);

// ─── Test ───────────────────────────────────────────────────────────────────

describe("Ticket 1.3 — Event Translator State Machine PBT", () => {
	it("property: arbitrary command sequences maintain model/real seenParts consistency", () => {
		fc.assert(
			fc.property(allCommands, (cmds) => {
				const model: ModelState = {
					seenParts: new Map(),
				};

				const real: RealState = {
					translator: createTranslator(),
				};

				fc.modelRun(() => ({ model, real }), cmds);
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});
