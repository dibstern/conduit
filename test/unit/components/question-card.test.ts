import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuestionCard from "../../../src/lib/frontend/components/chat/QuestionCard.svelte";
import type { QuestionRequest } from "../../../src/lib/frontend/types.js";

vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: vi.fn(() => "conduit"),
}));

vi.mock("../../../src/lib/frontend/stores/client-identity.js", () => ({
	getBrowserClientId: vi.fn(() => "client-1"),
}));

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	answerQuestionRpc: vi.fn(async () => undefined),
	rejectQuestionRpc: vi.fn(async () => undefined),
}));

function questionRequest(
	overrides: Partial<QuestionRequest> = {},
): QuestionRequest {
	return {
		toolId: "que-1",
		sessionId: "ses-1",
		questions: [
			{
				header: "Scope",
				question: "What should this cover?",
				options: [{ label: "Provider adapters" }],
				multiSelect: false,
				custom: false,
			},
		],
		...overrides,
	};
}

describe("QuestionCard", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows Skip for OpenCode questions", () => {
		render(QuestionCard, {
			props: { request: questionRequest({ providerId: "opencode" }) },
		});

		expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
	});

	it("hides Skip for Claude questions", () => {
		render(QuestionCard, {
			props: { request: questionRequest({ providerId: "claude" }) },
		});

		expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
	});
});
