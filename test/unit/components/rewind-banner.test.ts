import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RewindBanner from "../../../src/lib/frontend/components/overlays/RewindBanner.svelte";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";

interface RewindSessionInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly messageId: string;
}

const rewindSessionRpcSpy = vi.hoisted(() =>
	vi.fn(async (_input: RewindSessionInput) => undefined),
);
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock(
	"../../../src/lib/frontend/components/shared/Icon.svelte",
	emptyComponent,
);
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project-a",
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rewindSessionRpc: (input: RewindSessionInput) => rewindSessionRpcSpy(input),
}));

describe("RewindBanner", () => {
	beforeEach(() => {
		rewindSessionRpcSpy.mockClear();
		sessionState.currentId = "session-1";
		uiState.rewindActive = true;
		uiState.rewindSelectedUuid = "message-1";
	});

	afterEach(() => {
		cleanup();
		sessionState.currentId = null;
		uiState.rewindActive = false;
		uiState.rewindSelectedUuid = null;
	});

	it("confirms rewind through RPC for the active session", async () => {
		const { getByRole } = render(RewindBanner);

		await fireEvent.click(getByRole("button", { name: "Rewind" }));

		await waitFor(() => {
			expect(rewindSessionRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				messageId: "message-1",
			});
		});
		expect(uiState.rewindActive).toBe(false);
		expect(uiState.rewindSelectedUuid).toBeNull();
	});
});
