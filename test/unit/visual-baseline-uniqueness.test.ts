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

	// CONFIRMED BUG, tracked in conduit-test-732b. Kept here only so the gate can
	// be switched on; ChatLayout's baselines are the ConnectOverlay, not the
	// layout.
	"layout-chatlayout--default | layout-chatlayout--sidebar-collapsed | layout-chatlayout--with-rewind-banner | overlays-connectoverlay--connecting":
		"BUG: ChatLayout stories never leave the connecting state (conduit-test-732b)",
	"layout-chatlayout--default | layout-chatlayout--with-rewind-banner | overlays-connectoverlay--connecting":
		"BUG: ChatLayout stories never leave the connecting state (conduit-test-732b)",

	// Unverified pre-existing groups. Each is either a story whose distinguishing
	// state is not rendered, or a pair that legitimately looks identical. Being
	// listed here is not a claim that it is correct — see conduit-test-732b.
	"layout-header--connected | layout-header--processing | layout-header--sidebar-expanded | layout-header--with-terminal-badge":
		"unverified (conduit-test-732b)",
	"layout-header--connected | layout-header--processing | layout-header--with-terminal-badge":
		"unverified (conduit-test-732b)",
	"ui-toggle--default | ui-toggle--disabled": "unverified (conduit-test-732b)",
	"chat-systemmessage--hover | chat-systemmessage--info":
		"unverified (conduit-test-732b)",
	"session-sessionitem--inactive | session-sessionitem--with-context-menu":
		"unverified (conduit-test-732b)",
	"model-contextwindowselector--premium-default | model-contextwindowselector--selected-1-m":
		"unverified (conduit-test-732b)",
	"chat-planmode--collapsed | chat-planmode--content-card":
		"unverified (conduit-test-732b)",
	"chat-assistantmessage--copy-interaction | chat-assistantmessage--rich-markdown":
		"unverified (conduit-test-732b)",
	"overlays-notifsettings--open | overlays-notifsettings--push-blocked":
		"unverified (conduit-test-732b)",
	"project-projectswitcher--multiple-projects | project-projectswitcher--with-clients":
		"unverified (conduit-test-732b)",
	"todo-todooverlay--collapsed | todo-todooverlay--mixed-progress":
		"unverified (conduit-test-732b)",
	"pages-setuppage--done-step | pages-setuppage--pwa-step":
		"unverified (conduit-test-732b)",
	"ui-modal--default | ui-modal--non-dismissible":
		"unverified (conduit-test-732b); may differ only in behaviour",
	"overlays-attentionbanner--permissions-and-questions | overlays-notificationstack--attention-only":
		"unverified (conduit-test-732b); the stack may simply render the banner",
	"overlays-notificationstack--toasts-only | overlays-toast--multiple-toasts":
		"unverified (conduit-test-732b); the stack may simply render the toast",
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
