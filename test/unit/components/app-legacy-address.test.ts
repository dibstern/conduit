import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../../src/lib/frontend/App.svelte";
import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";

vi.mock(
	"../../../src/lib/frontend/components/layout/ChatLayout.svelte",
	() => import("../../helpers/SlugAtMountProbe.svelte"),
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/ConfirmModal.svelte",
	() => import("../../helpers/Empty.svelte"),
);
vi.mock(
	"../../../src/lib/frontend/components/session/SnoozePickerHost.svelte",
	() => import("../../helpers/Empty.svelte"),
);

describe("App with a legacy /p/<slug>/ address", () => {
	afterEach(cleanup);

	// ChatLayout connects the daemon socket on mount. If the address is still
	// /p/<slug>/ then, the socket carries no project, the daemon attaches its
	// first project, and the loads for the requested one fail mid-flight.
	it("normalizes the project into ?p= before the chat layout mounts", () => {
		routerState.path = "/p/skills/";
		routerState.search = "";

		render(App);

		expect(screen.getByTestId("slug-at-mount").textContent).toBe("skills");
		expect(routerState.search).toBe("?p=skills");
	});
});
