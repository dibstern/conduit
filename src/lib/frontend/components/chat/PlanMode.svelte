<!-- ─── Plan Mode ──────────────────────────────────────────────────────────── -->
<!-- Plan mode banners, collapsible content card with markdown, and approval     -->
<!-- buttons. Supports four modes: enter, exit, content, approval.              -->
<!-- Preserves .plan-banner, .plan-card, .plan-approval classes for E2E/CSS.    -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import { renderMarkdown } from "../../utils/markdown.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	let {
		mode,
		content = "",
		onApprove,
		onReject,
	}: {
		mode: "enter" | "exit" | "content" | "approval" | null;
		content?: string;
		onApprove?: (() => void) | undefined;
		onReject?: (() => void) | undefined;
	} = $props();

	// ─── Local state ─────────────────────────────────────────────────────────
	let collapsed = $state(false);
	let copyIcon = $state<"copy" | "check">("copy");
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Derived ─────────────────────────────────────────────────────────────
	const renderedHtml = $derived(content ? renderMarkdown(content) : "");

	const cardClass = $derived(
		collapsed ? "plan-card collapsed" : "plan-card",
	);

	// ─── Handlers ────────────────────────────────────────────────────────────

	function handleCopy(e: MouseEvent) {
		e.stopPropagation();
		if (!content) return;

		copyToClipboard(content);
		copyIcon = "check";
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copyIcon = "copy";
		}, 1500);
	}

	function toggleCollapse() {
		collapsed = !collapsed;
	}

	function handleApprove() {
		// Only call the callback — ChatLayout sets onApprove to send the message.
		// Sending here too would double-send (plan_approve is not a valid server
		// message type anyway; plan approval goes through the Question flow).
		onApprove?.();
	}

	function handleReject() {
		onReject?.();
	}
</script>

{#if mode === "enter"}
	<!-- Plan enter banner -->
	<div class="plan-banner plan-enter">
		<span class="plan-banner-icon">
			<Icon name="file-text" size={16} />
		</span>
		<span class="plan-banner-text">Entered plan mode</span>
		<span class="plan-banner-hint"
			>Exploring codebase and designing implementation...</span
		>
	</div>
{:else if mode === "exit"}
	<!-- Plan exit banner -->
	<div class="plan-banner plan-exit">
		<span class="plan-banner-icon">
			<Icon name="circle-check" size={16} />
		</span>
		<span class="plan-banner-text">Plan ready for review</span>
	</div>
{:else if mode === "content" && content}
	<!-- Plan content card (collapsible) -->
	<div class={cardClass}>
		<div
			class="plan-card-header"
			onclick={toggleCollapse}
			onkeydown={undefined}
			role="button"
			tabindex="0"
		>
			<span class="plan-card-icon">
				<Icon name="file-text" size={16} />
			</span>
			<span class="plan-card-title">Implementation Plan</span>
			<button
				class="plan-card-copy"
				title="Copy plan"
				onclick={handleCopy}
			>
				<Icon name={copyIcon} size={14} />
			</button>
			<span class="plan-card-chevron">
				<Icon name="chevron-down" size={16} />
			</span>
		</div>
		{#if !collapsed}
			<div class="plan-card-body">
				<div class="md-content text-sm leading-[1.7]">
					{@html renderedHtml}
				</div>
			</div>
		{/if}
	</div>
{:else if mode === "approval"}
	<!-- Plan approval buttons -->
	<div class="plan-approval">
		<button class="plan-approve-btn" onclick={handleApprove}>
			Approve Plan
		</button>
		<button class="plan-reject-btn" onclick={handleReject}>
			Reject Plan
		</button>
	</div>
{/if}
