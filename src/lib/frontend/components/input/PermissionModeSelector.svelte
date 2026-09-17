<!-- ─── Permission Mode (Approvals) Picker ───────────────────────────────── -->
<!-- Pill + dropdown for the session's approval mode.                         -->
<!-- Amber tint when not "ask" so elevated permissions are visibly active.    -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { switchPermissionModeRpc } from "../../transport/ws-rpc-client.js";
	import type { SessionPermissionMode } from "../../types.js";
	import { PERMISSION_MODES } from "../../permission-modes.js";

	// ─── State ──────────────────────────────────────────────────────────────

	let autoNormalizationProvider: string | null = null;

	// ─── Derived ────────────────────────────────────────────────────────────

	const currentMode = $derived(discoveryState.permissionMode);
	const currentLabel = $derived(
		PERMISSION_MODES.find((m) => m.mode === currentMode)?.label ?? "Ask",
	);
	const availableModes = $derived(
		PERMISSION_MODES.filter(
			({ claudeOnly }) =>
				!claudeOnly || discoveryState.currentProviderId === "claude",
		),
	);
	/** Tint the pill only when approvals are *relaxed*. "Never ask" is more
	 *  restrictive than "Ask", so flagging it as elevated would invert the
	 *  signal the amber tint exists to give. */
	const isElevated = $derived(
		PERMISSION_MODES.find((m) => m.mode === currentMode)?.elevated === true,
	);

	// ─── Handlers ───────────────────────────────────────────────────────────

	/** Always re-assert to the server, even when the pill already shows this
	 *  mode. The server keeps the mode in memory only, so a daemon restart
	 *  resets it to "ask" while this client still believes "Full access" — and
	 *  an equality short-circuit would make clicking "Full access" a silent
	 *  no-op, with no way back to it short of picking another mode first. The
	 *  RPC is idempotent, so asserting costs nothing and removes the trap. */
	function selectMode(mode: SessionPermissionMode) {
		const previousMode = discoveryState.permissionMode;
		discoveryState.permissionMode = mode;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			discoveryState.pendingPermissionMode = null;
			void switchPermissionModeRpc({ projectSlug, sessionId, mode }).catch(
				() => {
					if (discoveryState.permissionMode === mode) {
						discoveryState.permissionMode = previousMode;
					}
					// Without this the pill silently snaps back, which reads as a
					// frontend bug instead of what it is: the server rejected the
					// mode (typically a stale daemon that predates it).
					const label =
						PERMISSION_MODES.find((m) => m.mode === mode)?.label ?? mode;
					showToast(
						`Couldn't switch approval mode to "${label}" — the daemon rejected it. It may be running an older version.`,
						{ variant: "warn" },
					);
				},
			);
		} else {
			// No session bound yet (e.g. cold start before session_switched):
			// remember the choice; handleSessionSwitched flushes it on bind.
			discoveryState.pendingPermissionMode = mode;
		}
	}

	$effect(() => {
		const providerId = discoveryState.currentProviderId;
		if (providerId === "claude") {
			autoNormalizationProvider = null;
			return;
		}
		if (
			providerId &&
			discoveryState.permissionMode === "auto" &&
			autoNormalizationProvider !== providerId
		) {
			autoNormalizationProvider = providerId;
			selectMode("ask");
		}
	});
</script>

<!-- ui/Menu rather than a hand-rolled panel: the old markup was four plain
     buttons in a Surface with a hand-drawn checkmark, so assistive technology
     heard four unrelated controls and never that exactly one was current. It
     also carried its own Escape listener, outside-click action and open state,
     all of which the primitive already owns (conduit-test-de3.35.9.3).

     MenuRadioGroup is the honest shape here: "approvals is exactly one of
     these" is a radio group, and `aria-checked` says what the &#10003; glyph was
     only drawing. The check moves to the trailing edge because that is where
     every other radio menu in the app puts it. -->
<Menu
	ariaLabel="Approvals"
	side="top"
	align="end"
	sideOffset={4}
	class="w-40 font-brand"
	data-testid="permission-mode-dropdown"
>
	{#snippet trigger({ props })}
		<!-- The elevated state is a whole variant rather than a conditional class
		     list, because a call-site colour cannot be trusted to beat a variant's:
		     consumer `class` is additive, and Tailwind's emission order decides the
		     winner rather than the order you wrote them in. Both pill recipes now
		     live in ui/Button, so the two states cannot drift apart.

		     `ml-0.5` is the only thing left here: it is this pill's position in the
		     composer strip, which is the feature's business, not the pill's. -->
		<Button
			{...props}
			variant={isElevated ? "pill-warning" : "pill"}
			size="content"
			data-testid="permission-mode-badge"
			class="ml-0.5"
			title="Approvals ({currentLabel})"
		>
			{currentLabel}
			<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
		</Button>
	{/snippet}

	<MenuRadioGroup value={currentMode}>
		{#each availableModes as { mode, label } (mode)}
			<MenuRadioItem
				value={mode}
				data-testid="permission-mode-option-{mode}"
				onselect={() => selectMode(mode)}
			>
				{label}
			</MenuRadioItem>
		{/each}
	</MenuRadioGroup>
</Menu>
