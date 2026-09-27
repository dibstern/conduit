import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToolQuestionCard from "../../../src/lib/frontend/components/chat/ToolQuestionCard.svelte";
import { permissionsState } from "../../../src/lib/frontend/stores/permissions.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { mockQuestionRunning } from "../../../src/lib/frontend/stories/mocks.js";
import type { AskUserQuestion } from "../../../src/lib/frontend/types.js";

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	answerQuestionRpc: vi.fn(async () => undefined),
	rejectQuestionRpc: vi.fn(async () => undefined),
}));

const sameText: AskUserQuestion[] = [
	{
		header: "model selection",
		question: "Which model would you like to use for this task?",
		options: [],
		multiSelect: false,
		custom: true,
	},
];

function boundToolId(sessionId: string): string | null | undefined {
	sessionState.currentId = "ses-b";
	permissionsState.pendingQuestions = [
		{ toolId: "que-a", sessionId, questions: sameText },
	];
	const { container } = render(ToolQuestionCard, {
		props: { message: mockQuestionRunning },
	});
	return container
		.querySelector("[data-question-tool-id]")
		?.getAttribute("data-question-tool-id");
}

// Pending questions outlive session switches, so the text-match fallback
// must not bind another session's identical question.
describe("ToolQuestionCard content match", () => {
	afterEach(() => {
		cleanup();
		permissionsState.pendingQuestions = [];
		sessionState.currentId = null;
	});

	it("binds the viewed session's question by its text", () => {
		expect(boundToolId("ses-b")).toBe("que-a");
	});

	it("ignores another session's question with identical text", () => {
		expect(boundToolId("ses-a")).toBe(mockQuestionRunning.id);
	});
});
