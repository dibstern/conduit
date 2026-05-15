// ─── Question Mapping Unit Tests ────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { mapQuestionFields } from "../../../src/lib/bridges/question-bridge.js";

describe("mapQuestionFields", () => {
	it("maps OpenCode multiple to frontend multiSelect", () => {
		expect(
			mapQuestionFields([
				{
					question: "Pick one",
					header: "Choose",
					options: [{ label: "A", description: "Option A" }],
					multiple: true,
					custom: false,
				},
			]),
		).toEqual([
			{
				question: "Pick one",
				header: "Choose",
				options: [{ label: "A", description: "Option A" }],
				multiSelect: true,
				custom: false,
			},
		]);
	});

	it("defaults missing fields to frontend-safe values", () => {
		expect(mapQuestionFields([{}])).toEqual([
			{
				question: "",
				header: "",
				options: [],
				multiSelect: false,
				custom: true,
			},
		]);
	});

	it("normalizes incomplete options", () => {
		expect(
			mapQuestionFields([
				{
					options: [{ label: "A" }, { description: "Only description" }],
				},
			]),
		).toEqual([
			{
				question: "",
				header: "",
				options: [
					{ label: "A", description: "" },
					{ label: "", description: "Only description" },
				],
				multiSelect: false,
				custom: true,
			},
		]);
	});
});
