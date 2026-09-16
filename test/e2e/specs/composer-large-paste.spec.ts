// ─── Composer Large Paste ───────────────────────────────────────────────────
// Regression coverage for: pasting a log dump into the composer froze the tab.
// Two costs scaled with the draft, both on the input event's critical path —
// `autoResize()` read `scrollHeight`, forcing a synchronous layout of the whole
// value, and the highlight mirror laid the same text out a second time. A 1MB
// paste took ~320ms to settle and 16MB took ~5s, linear in size.
//
// Past HIGHLIGHT_MAX_CHARS the composer drops both: the mirror is emptied and
// the textarea paints its own text, and the height is pinned to the cap without
// measuring. This asserts that mechanism (a timing assertion would flake).
//
// Uses WS + RPC mocks — no real relay needed.

import { expect, test } from "@playwright/test";
import { initMessages } from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

/** Comfortably past the composer's 20k-char highlight limit. */
const LARGE_DRAFT = "conduit relay event log line\n".repeat(4_000);

test("@large-paste a pasted log dump bypasses the highlight mirror", async ({
	page,
}) => {
	await mockRelayWebSocket(page, { initMessages, responses: new Map() });
	await mockWsRpc(page, {
		handlers: {
			GetProjects: async () => ({
				projects: [{ slug: "myapp", name: "myapp", path: "/tmp/myapp" }],
			}),
		},
	});

	await page.goto("/p/myapp/");
	const textarea = page.locator("#input");
	await textarea.waitFor({ state: "visible", timeout: 20_000 });

	// A small draft is mirrored: the textarea's own text stays transparent.
	await textarea.fill("/commit the fix");
	const mirror = page.locator("#input-row div[aria-hidden='true']");
	await expect(mirror).toHaveText("/commit the fix");
	await expect(textarea).toHaveClass(/text-transparent/);

	await textarea.fill(LARGE_DRAFT);

	// The mirror is emptied — it never lays the draft out a second time…
	await expect(mirror).toHaveText("");
	// …and the textarea shows its own text instead, so the draft stays visible.
	await expect(textarea).not.toHaveClass(/text-transparent/);
	// Height is pinned to the cap without reading scrollHeight.
	await expect(textarea).toHaveAttribute("style", /height:\s*120px/);
	// The draft itself is untouched.
	expect(await textarea.inputValue()).toBe(LARGE_DRAFT);
});
