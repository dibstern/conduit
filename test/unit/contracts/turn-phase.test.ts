import { describe, expect, it } from "vitest";
import {
	phaseAfter,
	type TurnPhase,
	type TurnSignal,
} from "../../../src/lib/contracts/turn-phase.js";

describe("phaseAfter", () => {
	it.each<[TurnSignal, TurnPhase]>([
		["prompt", "pending"],
		["busy", "running"],
		["activity", "running"],
		["result", "settled"],
		["error", "settled"],
		["interrupt", "settled"],
	])("%s -> %s", (signal, expected) => {
		expect(phaseAfter(signal)).toBe(expected);
	});

	it("un-finishes a turn when activity follows completion", () => {
		expect(phaseAfter("result")).toBe("settled");
		expect(phaseAfter("activity")).toBe("running");
	});

	it("un-finishes a turn when the provider goes busy after completion", () => {
		expect(phaseAfter("result")).toBe("settled");
		expect(phaseAfter("busy")).toBe("running");
	});

	it("starts a fresh pending turn when a prompt follows completion", () => {
		expect(phaseAfter("result")).toBe("settled");
		expect(phaseAfter("prompt")).toBe("pending");
	});
});
