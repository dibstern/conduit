import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
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
	rpc: vi.fn(async () => ({ ok: true })),
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

	it("keeps labels and radio selections local when the same question appears in two panes", async () => {
		const request = questionRequest({ providerId: "claude" });
		const parent = render(QuestionCard, { props: { request } });
		const drawer = render(QuestionCard, { props: { request } });
		const parentRadio =
			parent.container.querySelector<HTMLInputElement>("input[type=radio]");
		const drawerRadio =
			drawer.container.querySelector<HTMLInputElement>("input[type=radio]");
		const drawerLabel = drawer.container.querySelector("label");
		if (!parentRadio || !drawerRadio || !drawerLabel)
			throw new Error("Missing question controls");
		await fireEvent.click(drawerLabel);
		expect(drawerRadio.checked).toBe(true);
		expect(parentRadio.checked).toBe(false);
		expect(
			within(drawer.container)
				.getByRole("button", { name: "Submit" })
				.hasAttribute("disabled"),
		).toBe(false);
		const parentLabel = parent.container.querySelector("label");
		if (!parentLabel) throw new Error("Missing parent question label");
		await fireEvent.click(parentLabel);
		expect(drawerRadio.checked).toBe(true);
		expect(parentRadio.checked).toBe(true);
	});
});
