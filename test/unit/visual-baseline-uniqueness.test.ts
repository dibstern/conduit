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

	// Verified legitimate (conduit-test-732b). Each of these was traced to the
	// source; the two stories genuinely produce the same frame.
	"layout-header--connected | layout-header--processing":
		"connected and processing share the same green dot once capture freezes the processing pulse at opacity 1; the difference is title and screen-reader text",
	"model-contextwindowselector--premium-default | model-contextwindowselector--selected-1-m":
		"premium default and an explicit 1M override both resolve to the same closed '1M (beta)' badge; they differ only inside the open dropdown",
	"overlays-attentionbanner--permissions-and-questions | overlays-notificationstack--attention-only":
		"both stories render NotificationStack with the same permission and question fixtures and no toasts",
	"overlays-notificationstack--toasts-only | overlays-toast--multiple-toasts":
		"both stories render NotificationStack with the same three toast messages and variants; only the toast ids differ, and those are iteration keys",

	// Verified legitimate (conduit-test-de3.35.9.3). For these three the
	// identical bytes are the assertion, not a hole in one.
	"ui-button--disabled | ui-button--disabled-hover":
		"DisabledHover IS Disabled plus the hover pseudo-state; a disabled button ignoring hover is precisely what the pair proves, so a pixel difference here would be the bug",
	"ui-segmentedcontrol--announces-radio-group-semantics | ui-segmentedcontrol--default":
		"the a11y story takes the default args untouched and asserts radiogroup/radio/aria-checked in play(); the control looks the same because the roles are invisible, which is the point",
	"ui-tabs--announces-tab-semantics | ui-tabs--underline | ui-tabs--underline-is-drawn-by-classes":
		"all three render the default tab strip: one asserts tablist/tab/aria-selected in play(), and one asserts the selected tab has no inline `style` attribute -- the underline it draws from `border-b-2` alone must be identical to the one the inline style used to draw, so byte equality is the proof that the dead-class fix was zero-diff",

	// Verified legitimate (conduit-test-6owk). ToolItem is a pure dispatcher
	// that passes each message unchanged to its selected card, and each pair uses
	// the same fixture in both stories. Once fa0f1041 pinned the visual suite's
	// clock, the identical bytes became proof of the expected dispatch.
	"chat-toolgenericcard--default | chat-toolitem--completed":
		"Both stories use mockToolCompleted, which ToolItem dispatches to ToolGenericCard.",
	"chat-toolgenericcard--error-state | chat-toolitem--error-state":
		"Both stories use mockToolError, which ToolItem dispatches to ToolGenericCard.",
	"chat-toolgenericcard--pending | chat-toolitem--pending":
		"Both stories use mockToolPending, which ToolItem dispatches to ToolGenericCard.",
	"chat-toolgenericcard--with-tags | chat-toolitem--read-with-offset-limit":
		"Both stories use mockToolReadWithOffset, which ToolItem dispatches to ToolGenericCard.",
	"chat-toolitem--question-answered | chat-toolquestioncard--default":
		"Both stories use mockQuestionAnswered, which ToolItem dispatches to ToolQuestionCard.",
	"chat-toolitem--question-pending | chat-toolquestioncard--waiting-without-question-data":
		"Both stories use mockQuestionPending, which ToolItem dispatches to ToolQuestionCard.",
	"chat-toolitem--question-skipped | chat-toolquestioncard--skipped":
		"Both stories use mockQuestionSkipped, which ToolItem dispatches to ToolQuestionCard.",
	"chat-toolitem--subagent-completed | chat-toolsubagentcard--default":
		"Both stories use mockToolSubagentCompleted, which ToolItem dispatches to ToolSubagentCard.",
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
