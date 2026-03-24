# Notification Stack Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Unify toasts and attention banners into a single top-right notification stack, fix toast stacking bug, suppress duplicate toasts for cross-session events already handled by attention items.

**Architecture:** New `NotificationStack.svelte` container owns fixed top-right positioning. `AttentionBanner` and `Toast` become relative-positioned children inside it. Toast default duration changes to 7s. Cross-session `ask_user`/`ask_user_resolved` events no longer fire redundant toasts.

**Tech Stack:** Svelte 5, Tailwind CSS, Storybook

> **Audit note:** Tasks 1-4 must be committed atomically (intermediate states break the UI due to fixed-inside-fixed positioning and pointer-events blocking).

---

### Task 1: Create NotificationStack + refactor Toast + AttentionBanner + wire into ChatLayout

This is a single atomic change. Intermediate states are broken (fixed-inside-fixed, pointer-events blocking), so all four sub-steps must be committed together.

**Files:**
- Create: `src/lib/frontend/components/overlays/NotificationStack.svelte`
- Modify: `src/lib/frontend/components/overlays/Toast.svelte`
- Modify: `src/lib/frontend/components/permissions/AttentionBanner.svelte:73-78`
- Modify: `src/lib/frontend/components/layout/ChatLayout.svelte:14,25,539-540,608-610`
- Modify: `test/unit/components/chat-layout-ws.test.ts:51-54,101-104`

**Step 1: Create NotificationStack.svelte**

```svelte
<!--
  NotificationStack — Unified notification container, fixed top-right.
  Renders AttentionBanner items above Toast items in a vertical stack.
-->
<script lang="ts">
	import AttentionBanner from "../permissions/AttentionBanner.svelte";
	import Toast from "./Toast.svelte";
</script>

<div class="fixed top-16 right-4 z-[400] max-w-[320px] flex flex-col gap-2 pointer-events-none">
	<AttentionBanner />
	<Toast />
</div>
```

**Step 2: Rewrite Toast.svelte**

Replace the entire file:

```svelte
<!--
  Toast — Auto-dismissing notification toasts.
  Reads uiState.toasts and renders each toast as a card inside NotificationStack.
  Auto-dismiss is handled by the store's showToast() via setTimeout.
-->
<script lang="ts">
	import { uiState } from "../../stores/ui.svelte.js";
</script>

{#each uiState.toasts as toast (toast.id)}
	<div
		class="pointer-events-auto w-full px-4 py-2 rounded-lg text-sm font-medium shadow-lg notification-slide-in {toast.variant === 'warn'
			? 'bg-warning-bg border border-warning text-warning'
			: 'bg-bg-alt border border-border text-text'}"
		role="status"
		aria-live="polite"
	>
		{toast.message}
	</div>
{/each}

<style>
	.notification-slide-in {
		animation: slideInRight 200ms ease-out both;
	}

	@keyframes slideInRight {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
```

Key changes:
- Removed `fixed bottom-20 left-1/2 -translate-x-1/2 z-[400]`
- Added `pointer-events-auto` (parent stack is `pointer-events-none`) and `w-full` for consistent width
- Changed animation from `slideUpFadeIn` to `slideInRight` to match the stack direction
- Multiple toasts now stack naturally via the parent flexbox `gap-2`

**Step 3: Strip fixed positioning from AttentionBanner.svelte**

Replace the outer `<div>` wrapper (lines 74-78):

Old:
```svelte
	<div
		class="fixed top-16 right-4 z-[350] max-w-[320px] permission-notification-enter"
		role="status"
		aria-live="polite"
	>
```

New:
```svelte
	<div
		class="pointer-events-auto permission-notification-enter"
		role="status"
		aria-live="polite"
	>
```

**Step 4: Update ChatLayout.svelte imports**

Remove:
```ts
import Toast from "../overlays/Toast.svelte";
```
```ts
import AttentionBanner from "../permissions/AttentionBanner.svelte";
```

Add:
```ts
import NotificationStack from "../overlays/NotificationStack.svelte";
```

**Step 5: Remove standalone AttentionBanner from #app**

Remove lines 539-540:
```svelte
		<!-- Cross-session attention banner (permissions & questions from other sessions) -->
		<AttentionBanner />
```

**Step 6: Replace standalone Toast in global overlays**

Replace line 610:
```svelte
<Toast />
```

With:
```svelte
<NotificationStack />
```

Update the comment on line 608:
```svelte
<!-- Global overlays + notification stack (outside layout for proper z-index stacking) -->
```

**Step 7: Update test mocks in chat-layout-ws.test.ts**

Replace the Toast mock (lines 51-54):
```ts
vi.mock(
	"../../../src/lib/frontend/components/overlays/Toast.svelte",
	emptyComponent,
);
```

With:
```ts
vi.mock(
	"../../../src/lib/frontend/components/overlays/NotificationStack.svelte",
	emptyComponent,
);
```

Remove the AttentionBanner mock (lines 101-104):
```ts
vi.mock(
	"../../../src/lib/frontend/components/permissions/AttentionBanner.svelte",
	emptyComponent,
);
```

(ChatLayout no longer imports Toast or AttentionBanner directly — it imports NotificationStack, which imports them internally. The stale mocks are harmless but misleading.)

**Step 8: Verify everything compiles and tests pass**

Run: `pnpm check && pnpm test:unit`
Expected: All pass

**Step 9: Commit**

```
feat: unify Toast and AttentionBanner into NotificationStack

Create NotificationStack.svelte container with fixed top-right positioning.
Refactor Toast and AttentionBanner to be relative-positioned children.
Fix toast stacking bug (multiple toasts now stack via flexbox gap).
```

---

### Task 2: Change default toast duration to 7 seconds

**Files:**
- Modify: `src/lib/frontend/stores/ui.svelte.ts:171`
- Modify: `test/unit/stores/ui-store.test.ts:140`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:689-692`

**Step 1: Update the default duration**

In `ui.svelte.ts`, change line 171 from:
```ts
		duration: options?.duration ?? 2000,
```
To:
```ts
		duration: options?.duration ?? 7000,
```

**Step 2: Update the test assertion**

In `ui-store.test.ts`, change line 140 from:
```ts
		expect(uiState.toasts[0]!.duration).toBe(2000);
```
To:
```ts
		expect(uiState.toasts[0]!.duration).toBe(7000);
```

**Step 3: Remove explicit 4000ms from INSTANCE_ERROR handler**

In `ws-dispatch.ts`, change lines 689-692 from:
```ts
		showToast(msg.message ?? "Instance operation failed", {
			variant: "warn",
			duration: 4000,
		});
```
To:
```ts
		showToast(msg.message ?? "Instance operation failed", {
			variant: "warn",
		});
```

(The 4000ms override was intentionally longer than the old 2000ms default, but is now shorter than the new 7000ms default. Per user decision, let it use the default.)

**Step 4: Verify and test**

Run: `pnpm check && pnpm test:unit`
Expected: All pass

**Step 5: Commit**

```
feat: increase default toast duration from 2s to 7s
```

---

### Task 3: Suppress duplicate toasts for cross-session ask_user events

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:506-513`

**Step 1: Guard the toast call**

Replace lines 506-513:

Old:
```ts
			// In-app toast so cross-session events are visible even when
			// browser Notification permission is missing or push is stale.
			const content = notificationContent(syntheticMsg);
			if (content) {
				showToast(content.title + (content.body ? ` — ${content.body}` : ""), {
					variant: msg.eventType === "error" ? "warn" : "default",
				});
			}
```

New:
```ts
			// In-app toast for cross-session events — skip for ask_user and
			// ask_user_resolved since the AttentionBanner already handles those.
			if (msg.eventType !== "ask_user" && msg.eventType !== "ask_user_resolved") {
				const content = notificationContent(syntheticMsg);
				if (content) {
					showToast(content.title + (content.body ? ` — ${content.body}` : ""), {
						variant: msg.eventType === "error" ? "warn" : "default",
					});
				}
			}
```

**Step 2: Verify and test**

Run: `pnpm check && pnpm test:unit`
Expected: All pass

**Step 3: Commit**

```
fix: suppress duplicate toasts for ask_user events handled by AttentionBanner
```

---

### Task 4: Update Storybook stories

**Files:**
- Modify: `src/lib/frontend/components/overlays/Toast.stories.ts`
- Modify: `src/lib/frontend/components/permissions/AttentionBanner.stories.ts`
- Create: `src/lib/frontend/components/overlays/NotificationStack.stories.ts`

**Step 1: Replace Toast.stories.ts**

```ts
import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { permissionsState } from "../../stores/permissions.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import type { Toast as ToastType } from "../../types.js";
import NotificationStack from "./NotificationStack.svelte";

const meta = {
	title: "Overlays/Toast",
	component: NotificationStack,
	beforeEach: () => {
		uiState.toasts = [];
		permissionsState.pendingPermissions = [];
		permissionsState.remoteQuestionSessions = new Set();
	},
} satisfies Meta<typeof NotificationStack>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Helper to set toasts directly without auto-dismiss. */
function setToasts(toasts: ToastType[]): void {
	uiState.toasts = toasts;
}

export const DefaultToast: Story = {
	play: () => {
		setToasts([
			{
				id: "story-default-1",
				message: "Session created successfully",
				variant: "default",
				duration: 999999,
			},
		]);
	},
};

export const WarnToast: Story = {
	play: () => {
		setToasts([
			{
				id: "story-warn-1",
				message: "Context window is almost full (92%)",
				variant: "warn",
				duration: 999999,
			},
		]);
	},
};

export const MultipleToasts: Story = {
	play: () => {
		setToasts([
			{
				id: "story-multi-1",
				message: "File saved",
				variant: "default",
				duration: 999999,
			},
			{
				id: "story-multi-2",
				message: "Connection lost",
				variant: "warn",
				duration: 999999,
			},
			{
				id: "story-multi-3",
				message: "Reconnected",
				variant: "default",
				duration: 999999,
			},
		]);
	},
};
```

**Step 2: Replace AttentionBanner.stories.ts**

```ts
import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { flushSync } from "svelte";
import { permissionsState } from "../../stores/permissions.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import type { PermissionId } from "../../types.js";
import NotificationStack from "../overlays/NotificationStack.svelte";

// ─── Helpers ────────────────────────────────────────────────────────────────

function setupState(opts: {
	currentId?: string;
	permissions?: Array<{
		id: string;
		sessionId: string;
		toolName: string;
	}>;
	questionSessions?: string[];
	sessionTitles?: Record<string, string>;
}) {
	flushSync(() => {
		sessionState.currentId = opts.currentId ?? "ses_current";
		sessionState.allSessions = Object.entries(opts.sessionTitles ?? {}).map(
			([id, title]) => ({
				id,
				title,
				createdAt: Date.now(),
			}),
		) as typeof sessionState.allSessions;

		permissionsState.pendingPermissions = (opts.permissions ?? []).map((p) => ({
			...p,
			requestId: p.id as PermissionId,
			toolName: p.toolName,
			toolInput: {},
		}));

		permissionsState.remoteQuestionSessions = new Set(
			opts.questionSessions ?? [],
		);
	});
}

// ─── Meta ───────────────────────────────────────────────────────────────────

const meta = {
	title: "Permissions/AttentionBanner",
	component: NotificationStack,
	tags: ["autodocs"],
	beforeEach: () => {
		uiState.toasts = [];
		permissionsState.pendingPermissions = [];
		permissionsState.remoteQuestionSessions = new Set();
	},
} satisfies Meta<typeof NotificationStack>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Stories ────────────────────────────────────────────────────────────────

export const SinglePermission: Story = {
	play: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			sessionTitles: { ses_other1: "Fix authentication bug" },
		});
	},
};

export const MultiplePermissions: Story = {
	play: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
				{ id: "perm-2", sessionId: "ses_other1", toolName: "edit" },
				{ id: "perm-3", sessionId: "ses_other2", toolName: "bash" },
			],
			sessionTitles: {
				ses_other1: "Fix authentication bug",
				ses_other2: "Refactor database layer",
			},
		});
	},
};

export const SingleQuestion: Story = {
	play: () => {
		setupState({
			questionSessions: ["ses_other1"],
			sessionTitles: { ses_other1: "API redesign" },
		});
	},
};

export const PermissionsAndQuestions: Story = {
	play: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			questionSessions: ["ses_other2"],
			sessionTitles: {
				ses_other1: "Fix authentication bug",
				ses_other2: "API redesign",
			},
		});
	},
};

export const MixedSameSession: Story = {
	name: "Same session has both",
	play: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			questionSessions: ["ses_other1"],
			sessionTitles: { ses_other1: "Fix authentication bug" },
		});
	},
};

export const NoNotifications: Story = {
	name: "Empty (hidden)",
};
```

**Step 3: Create NotificationStack.stories.ts**

```ts
import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { flushSync } from "svelte";
import { permissionsState } from "../../stores/permissions.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import type { PermissionId, Toast as ToastType } from "../../types.js";
import NotificationStack from "./NotificationStack.svelte";

const meta = {
	title: "Overlays/NotificationStack",
	component: NotificationStack,
	tags: ["autodocs"],
	beforeEach: () => {
		uiState.toasts = [];
		permissionsState.pendingPermissions = [];
		permissionsState.remoteQuestionSessions = new Set();
	},
} satisfies Meta<typeof NotificationStack>;

export default meta;
type Story = StoryObj<typeof meta>;

function setToasts(toasts: ToastType[]): void {
	uiState.toasts = toasts;
}

function setupAttention(opts: {
	permissions?: Array<{ id: string; sessionId: string; toolName: string }>;
	questionSessions?: string[];
	sessionTitles?: Record<string, string>;
}) {
	flushSync(() => {
		sessionState.currentId = "ses_current";
		sessionState.allSessions = Object.entries(opts.sessionTitles ?? {}).map(
			([id, title]) => ({
				id,
				title,
				createdAt: Date.now(),
			}),
		) as typeof sessionState.allSessions;

		permissionsState.pendingPermissions = (opts.permissions ?? []).map((p) => ({
			...p,
			requestId: p.id as PermissionId,
			toolName: p.toolName,
			toolInput: {},
		}));

		permissionsState.remoteQuestionSessions = new Set(
			opts.questionSessions ?? [],
		);
	});
}

export const ToastsOnly: Story = {
	play: () => {
		setToasts([
			{ id: "t1", message: "File saved", variant: "default", duration: 999999 },
			{ id: "t2", message: "Connection lost", variant: "warn", duration: 999999 },
		]);
	},
};

export const AttentionOnly: Story = {
	play: () => {
		setupAttention({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			questionSessions: ["ses_other2"],
			sessionTitles: {
				ses_other1: "Fix authentication bug",
				ses_other2: "API redesign",
			},
		});
	},
};

export const Combined: Story = {
	name: "Attention + Toasts",
	play: () => {
		setupAttention({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			sessionTitles: { ses_other1: "Fix authentication bug" },
		});
		setToasts([
			{ id: "t1", message: "Copied to clipboard", variant: "default", duration: 999999 },
			{ id: "t2", message: "Rate limited", variant: "warn", duration: 999999 },
		]);
	},
};
```

**Step 4: Verify everything**

Run: `pnpm check && pnpm lint`
Expected: No errors

**Step 5: Commit**

```
feat: update Storybook stories for NotificationStack with cleanup hooks
```

---

### Task 5: Final verification

**Step 1: Full check + lint + test suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Step 2: Visual verification in Storybook**

Open Storybook and verify:
- `Overlays/Toast/MultipleToasts` — toasts stack vertically in top-right, no overlap
- `Overlays/NotificationStack/Combined` — attention items appear above toasts
- `Permissions/AttentionBanner/*` — all stories render correctly in the stack

**Step 3: Visual verification in the app**

Open `http://localhost:2633/` and verify:
- Trigger a toast (e.g. copy something) — appears in top-right
- Multiple toasts stack properly
- If multiple sessions have pending items, AttentionBanner appears above toasts
