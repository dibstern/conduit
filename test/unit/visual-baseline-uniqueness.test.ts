import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Two baselines with identical bytes are two stories asserting one fact. That is
 * fine when the stories genuinely end in the same frame, and a silent hole when
 * they do not: Layout/ChatLayout's three baselines were pixel-for-pixel the
 * ConnectOverlay, so a component with three passing visual tests had no visual
 * coverage at all. Those images carry 1747 distinct colours, so no
 * "is it blank" heuristic finds them — only comparing stories to each other does.
 *
 * This gate is a RATCHET. The groups below already existed when it was written
 * and are being worked down under conduit-test-732b; what the gate prevents is a
 * NEW pair appearing unnoticed, which matters most during de3.5, whose fidelity
 * protocol rests on "zero pixel diff proves the migration changed nothing".
 *
 * To clear an entry: make the stories differ (usually by rendering the state the
 * story name claims), recapture, and delete the line.
 */
const ALLOWED_DUPLICATE_GROUPS: Record<string, string> = {
	// Verified legitimate: these interaction stories deliberately re-open the
	// surface as their final step, so an open menu IS the terminal state. Their
	// real assertions live in play(), not in the pixels.
	"ui-menu--default | ui-menu--escape-restores-focus | ui-menu--selecting-item-restores-focus":
		"both interaction stories re-open the menu as their last step",
	"ui-menu--arrow-key-navigation | ui-menu--typeahead":
		"both end with focus on the same item",
	"ui-popover--default | ui-popover--escape-restores-focus":
		"escape story re-opens the popover as its last step",

	// Verified legitimate: these components render nothing in the state shown.
	"layout-sidebar--default | layout-sidebar--file-browser-panel | layout-sidebar--hover | layout-sidebar--loading | overlays-attentionbanner--no-notifications":
		"all render nothing: mobile sidebar is off-canvas (conduit-test-7jv)",

	// Verified legitimate (conduit-test-732b). Each of these was traced to the
	// source; the two stories genuinely produce the same frame.
	"layout-header--connected | layout-header--processing":
		"connected and processing share the same green dot once capture freezes the processing pulse at opacity 1; the difference is title and screen-reader text",
	"layout-header--connected | layout-header--processing | layout-header--sidebar-expanded":
		"as above, plus: on mobile the desktop expand button is hidden and both sidebar states render the same hamburger",
	"model-contextwindowselector--premium-default | model-contextwindowselector--selected-1-m":
		"premium default and an explicit 1M override both resolve to the same closed '1M (beta)' badge; they differ only inside the open dropdown",
	"overlays-attentionbanner--permissions-and-questions | overlays-notificationstack--attention-only":
		"both stories render NotificationStack with the same permission and question fixtures and no toasts",
	"overlays-notificationstack--toasts-only | overlays-toast--multiple-toasts":
		"both stories render NotificationStack with the same three toast messages and variants; only the toast ids differ, and those are iteration keys",

	// MISSING VISUAL DESIGN, not a broken story (conduit-test-732b). The state IS
	// applied; the component simply has no visual treatment for it, so the two
	// frames are identical by omission. These are design decisions, not test bugs,
	// and they are listed here so the gate stays honest until they are made.
	"ui-toggle--default | ui-toggle--disabled":
		"disabled only adds `disabled:cursor-not-allowed` and the DOM attribute, neither of which contributes pixels; the component already has a `dimmed` opacity-40 treatment that disabled does not use (conduit-test-wzat)",
	"chat-systemmessage--hover | chat-systemmessage--info":
		"the info card has no hover treatment at all; the only hover style in the component belongs to a 'Show details' button the fixture does not render (conduit-test-wzat)",
};

const BASELINE_DIRECTORY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../visual/components.spec.ts-snapshots",
);

const BASELINE_NAME = /^(.*)-(desktop|mobile)-(darwin|linux)\.png$/;

describe("visual baseline uniqueness", () => {
	it("has no undeclared byte-identical baselines across stories", () => {
		// Keyed by viewport+platform+bytes: the same story legitimately differs
		// between viewports and platforms, so only same-context images compare.
		const byContent = new Map<string, Set<string>>();

		for (const file of readdirSync(BASELINE_DIRECTORY)) {
			const match = BASELINE_NAME.exec(file);
			if (!match) continue;
			const [, storyId, viewport, platform] = match;
			const hash = createHash("sha1")
				.update(readFileSync(resolve(BASELINE_DIRECTORY, file)))
				.digest("hex");
			const key = `${viewport}:${platform}:${hash}`;
			const stories = byContent.get(key) ?? new Set<string>();
			stories.add(storyId as string);
			byContent.set(key, stories);
		}

		const undeclared = new Set<string>();
		for (const stories of byContent.values()) {
			if (stories.size < 2) continue;
			const group = [...stories].sort().join(" | ");
			if (!(group in ALLOWED_DUPLICATE_GROUPS)) undeclared.add(group);
		}

		expect(
			[...undeclared].sort(),
			"These stories have byte-identical baselines, so all but one of them " +
				"assert nothing. Usually the story's distinguishing state is not " +
				"actually rendered. Fix the story and recapture; if the stories " +
				"genuinely end in the same frame, add the group to " +
				"ALLOWED_DUPLICATE_GROUPS with the reason.",
		).toEqual([]);
	});

	it("declares no allowlist entry that has already been fixed", () => {
		// A stale exemption is a hole that reopens silently the next time two
		// baselines collide, so the allowlist has to shrink as the bugs are fixed.
		const live = new Set<string>();
		const byContent = new Map<string, Set<string>>();
		for (const file of readdirSync(BASELINE_DIRECTORY)) {
			const match = BASELINE_NAME.exec(file);
			if (!match) continue;
			const [, storyId, viewport, platform] = match;
			const hash = createHash("sha1")
				.update(readFileSync(resolve(BASELINE_DIRECTORY, file)))
				.digest("hex");
			const key = `${viewport}:${platform}:${hash}`;
			const stories = byContent.get(key) ?? new Set<string>();
			stories.add(storyId as string);
			byContent.set(key, stories);
		}
		for (const stories of byContent.values()) {
			if (stories.size > 1) live.add([...stories].sort().join(" | "));
		}

		expect(
			Object.keys(ALLOWED_DUPLICATE_GROUPS)
				.filter((group) => !live.has(group))
				.sort(),
			"These allowlist entries no longer match any duplicate. Delete them.",
		).toEqual([]);
	});
});
