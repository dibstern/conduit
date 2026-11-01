<script lang="ts">
	import type { SessionPermissionMode } from "../../types.js";
	import { PERMISSION_MODE_COLOURS } from "../../permission-modes.js";
	import Button from "./Button.svelte";
	import PermissionShield from "./PermissionShield.svelte";

	let { mode, label, variant = "icons", loading = false, ...rest }: {
		mode: SessionPermissionMode;
		label: string;
		variant?: "icons" | "words" | "summary";
		loading?: boolean;
		[key: string]: unknown;
	} = $props();
	const tone = $derived(PERMISSION_MODE_COLOURS[mode]);
	const word = $derived({ dontAsk: "never", plan: "plan", ask: "ask", acceptEdits: "edits", auto: "auto", full: "full" }[mode]);
</script>

{#if variant === "summary"}
	<span style:color={tone}>{word}</span>
{:else if variant === "words"}
	<Button {...rest} variant="composer-word" size="content" tone="inherit" {loading} ariaLabel={`Permissions: ${label}. Open options`} style={`color: ${tone}`} touchTarget>{word}</Button>
{:else}
	<Button {...rest} variant="ghost" size="composer-icon" tone="inherit" {loading} ariaLabel={`Permissions: ${label}. Open options`} title={`Permissions (${label})`} touchTarget>
		<PermissionShield {mode} size={17} />
	</Button>
{/if}
