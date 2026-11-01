import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, string>();

beforeEach(() => {
	stored.clear();
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => {
			stored.set(key, value);
		},
	});
});

describe("Files pane session memory", () => {
	it("restores Files or Diff and their shared width for each session after reload", async () => {
		const {
			noteSessionChanged,
			sessionViewState,
			setRightPaneView,
			setRightPaneWidth,
		} = await import("../../../src/lib/frontend/stores/session-view.svelte.js");
		noteSessionChanged("first");
		expect(sessionViewState.rightPaneView).toBe("closed");
		expect(sessionViewState.rightPaneWidth).toBeNull();
		setRightPaneView("files");
		setRightPaneWidth(412);
		setRightPaneView("diff");
		noteSessionChanged("second");
		expect(sessionViewState.rightPaneView).toBe("closed");
		vi.resetModules();
		const reloaded = await import(
			"../../../src/lib/frontend/stores/session-view.svelte.js"
		);
		reloaded.noteSessionChanged("first");
		expect(reloaded.sessionViewState.rightPaneView).toBe("diff");
		expect(reloaded.sessionViewState.rightPaneWidth).toBe(412);
		reloaded.noteSessionChanged("second");
		expect(reloaded.sessionViewState.rightPaneView).toBe("closed");
	});

	it("ignores malformed entries and retains only the 100 most recent sessions", async () => {
		stored.set(
			"files-pane-by-session",
			JSON.stringify({
				bad: { filesOpen: "yes", width: -1 },
				valid: { filesOpen: true, width: 320 },
			}),
		);
		const { noteSessionChanged, sessionViewState, setRightPaneView } =
			await import("../../../src/lib/frontend/stores/session-view.svelte.js");
		noteSessionChanged("bad");
		expect(sessionViewState.rightPaneView).toBe("closed");
		noteSessionChanged("valid");
		expect(sessionViewState.rightPaneWidth).toBe(320);
		for (let i = 0; i < 101; i++) {
			noteSessionChanged(`session-${i}`);
			setRightPaneView("files");
		}
		const entries = JSON.parse(
			stored.get("files-pane-by-session") ?? "{}",
		) as Record<string, unknown>;
		expect(Object.keys(entries)).toHaveLength(100);
		expect(entries).not.toHaveProperty("session-0");
		expect(entries).toHaveProperty("session-100");
	});

	it("does not persist a phone Files preference", async () => {
		const {
			noteSessionChanged,
			sessionViewState,
			setRightPaneView,
			setRightPaneWidth,
		} = await import("../../../src/lib/frontend/stores/session-view.svelte.js");
		noteSessionChanged("phone");
		sessionViewState.compact = true;
		setRightPaneView("files");
		setRightPaneWidth(350);
		expect(stored.has("files-pane-by-session")).toBe(false);
	});
});
