import { describe, expect, it } from "vitest";
import { CanonicalEventTranslator } from "../../../src/lib/persistence/canonical-event-translator.js";

describe("CanonicalEventTranslator — normalized tool input", () => {
	it("tool.started carries CanonicalToolInput for pending tool", () => {
		const translator = new CanonicalEventTranslator();
		const events = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					messageID: "msg-1",
					partID: "part-1",
					part: {
						type: "tool",
						id: "part-1",
						tool: "read",
						callID: "call-1",
						state: {
							status: "pending",
							input: { filePath: "/src/main.ts", offset: 5 },
						},
					},
				},
			} as never,
			"ses-1",
		);

		expect(events).not.toBeNull();
		const toolStarted = events!.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted!.data.input).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 5,
		});
	});

	it("tool.started carries CanonicalToolInput when first seen as running", () => {
		const translator = new CanonicalEventTranslator();
		const events = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					messageID: "msg-1",
					partID: "part-2",
					part: {
						type: "tool",
						id: "part-2",
						tool: "bash",
						callID: "call-2",
						state: {
							status: "running",
							input: { command: "ls -la" },
						},
					},
				},
			} as never,
			"ses-1",
		);

		expect(events).not.toBeNull();
		const toolStarted = events!.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted!.data.input).toEqual({
			tool: "Bash",
			command: "ls -la",
		});
	});
});
