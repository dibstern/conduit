<script lang="ts">
	import type { SessionPermissionMode } from "../../types.js";
	import { PERMISSION_MODE_COLOURS } from "../../permission-modes.js";
	import Button from "./Button.svelte";
	import Icon from "./Icon.svelte";
	import PermissionShield from "./PermissionShield.svelte";

	let { mode, label, variant = "icons", loading = false, ...rest }: {
		mode: SessionPermissionMode;
		label: string;
		variant?: "icons" | "words" | "row" | "summary";
		loading?: boolean;
		[key: string]: unknown;
	} = $props();
	const tone = $derived(PERMISSION_MODE_COLOURS[mode]);
	const word = $derived({ dontAsk: "never", plan: "plan", ask: "ask", acceptEdits: "edits", auto: "auto", full: "full" }[mode]);
</script>

{#if variant === "summary"}
	<span style:color={tone}>{word}</span>
{:else if variant === "row"}
	<Button {...rest} variant="composer-row" size="content" {loading} ariaLabel={`Approvals: ${label}. Open options`}>
		<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Mode</span>
		<span data-part="value" class="flex min-w-0 flex-1 items-center gap-[7px] font-semibold" style:color={tone}><PermissionShield {mode} size={15} />{label}</span>
		<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
	</Button>
{:else if variant === "words"}
	<Button {...rest} variant="composer-word" size="content" tone="inherit" {loading} ariaLabel={`Approvals: ${label}. Open options`} style={`color: ${tone}`} touchTarget>{word}</Button>
{:else}
	<Button {...rest} variant="ghost" size="composer-icon" tone="inherit" {loading} ariaLabel={`Approvals: ${label}. Open options`} title={`Approvals (${label})`} touchTarget>
		<PermissionShield {mode} size={17} />
	</Button>
{/if}
