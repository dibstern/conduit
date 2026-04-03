<!-- ─── Banners ───────────────────────────────────────────────────────────── -->
<!-- Banner bar at top of chat area, driven by uiState.banners.              -->
<!-- Supports update (green), onboarding (orange), skip-permissions (red),  -->
<!-- warning (amber/yellow).                                                -->
<!-- Dismissible banners show a close button that calls removeBanner(id).    -->

<script lang="ts">
	import type { BannerConfig } from "../../types.js";
	import { uiState, removeBanner } from "../../stores/ui.svelte.js";
	import { instanceState } from "../../stores/instance.svelte.js";
	import Icon from "../shared/Icon.svelte";
	import { assertNever } from "../../../utils.js";

	// ─── Instance health check ─────────────────────────────────────────────────
	// Show the warning banner only when ALL instances are "unhealthy" — meaning
	// they should be running but aren't responding to health checks.
	// "stopped" (intentionally off) and "starting" (booting up) are normal
	// states that shouldn't trigger an alarm.

	const showInstanceWarning = $derived.by(() => {
		const instances = instanceState.instances;
		if (instances.length === 0) return false;
		// Every instance must be unhealthy (not stopped, not starting, not healthy)
		return instances.every((i) => i.status === "unhealthy");
	});

	function handleManageInstances() {
		window.dispatchEvent(new CustomEvent("settings:open", { detail: { tab: "instances" } }));
	}

	// ─── Variant styling ────────────────────────────────────────────────────────

	function getVariantClasses(variant: BannerConfig["variant"]): string {
		switch (variant) {
		case "update":
			return "bg-success/[0.08] border-success/30 text-success";
			case "onboarding":
				return "bg-accent-bg border-accent/30 text-accent";
			case "skip-permissions":
				return "bg-error/10 border-error/30 text-error";
		case "warning":
			return "bg-warning-bg border-warning/30 text-warning";
			default:
				return assertNever(variant);
		}
	}
</script>

{#if showInstanceWarning}
	<div class="banner flex items-center gap-2 px-4 py-2 text-xs border-b bg-error/10 border-error/30 text-error">
		<span class="banner-icon shrink-0">
			<Icon name="alert-triangle" size={14} />
		</span>
		<span class="banner-text flex-1 min-w-0">
			No healthy OpenCode instances
		</span>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span
			class="shrink-0 text-current underline cursor-pointer hover:opacity-80"
			onclick={handleManageInstances}
		>
			Manage Instances
		</span>
	</div>
{/if}

{#if uiState.banners.length > 0}
	<div class="banners flex flex-col">
		{#each uiState.banners as banner (banner.id)}
			<div
				class="banner flex items-center gap-2 px-4 py-2 text-xs border-b {getVariantClasses(banner.variant)}"
				data-banner-id={banner.id}
			>
				<span class="banner-icon shrink-0">
					<Icon name={banner.icon} size={14} />
				</span>
				<span class="banner-text flex-1 min-w-0">
					{banner.text}
				</span>
				{#if banner.link}
					<a
						href={banner.link}
						target="_blank"
						rel="noopener noreferrer"
						class="shrink-0 text-current underline cursor-pointer hover:opacity-80"
					>
						npm
					</a>
				{/if}
				{#if banner.dismissible}
					<button
						class="banner-dismiss shrink-0 text-current opacity-60 hover:opacity-100 cursor-pointer bg-transparent border-none p-0 leading-none"
						title="Dismiss"
						onclick={() => removeBanner(banner.id)}
					>
						<Icon name="x" size={14} />
					</button>
				{/if}
			</div>
		{/each}
	</div>
{/if}
