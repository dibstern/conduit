<!-- Banner bar at top of chat area, driven by uiState.banners plus the
     instance-health warning. Supports update (green), onboarding (orange),
     skip-permissions and error (red), warning (amber/yellow). Dismissible
     banners show a close button that calls removeBanner(id). The collapsed
     phone header shows these as one line instead (BannersRow). -->

<script module lang="ts">
	import type { BannerConfig } from "../../types.js";
	import { uiState } from "../../stores/ui.svelte.js";
	import { getEffectiveInstanceId, getSessionDriver } from "../../stores/discovery.svelte.js";
	import { getCachedInstances, getDriverTraits, getInstanceTraits, instanceState } from "../../stores/instance.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { assertNever } from "../../../utils.js";
	import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/account.js";
	import { openSettings } from "../layout/chrome-actions.js";

	const INSTANCE_WARNING: BannerConfig = {
		id: "no-healthy-instances",
		variant: "error",
		icon: "alert-triangle",
		text: "No healthy OpenCode instances",
		summary: "No healthy instances",
		dismissible: false,
		action: {
			label: "Manage Instances",
			run: () => openSettings("server", "instances"),
		},
	};

	// Warn only when ALL instances are "unhealthy" — meaning they should be
	// running but aren't responding to health checks. "stopped" (intentionally
	// off) and "starting" (booting up) are normal states.
	function instanceWarningShown(): boolean {
		const instances = instanceState.instances.filter((instance) => getInstanceTraits(instance.id)?.runsOpenCodeServer);
		if (instances.length === 0) return false;
		if (!instances.every((i) => i.status === "unhealthy")) return false;
		if (sessionState.currentId) return getDriverTraits(getSessionDriver(sessionState.currentId))?.runsOpenCodeServer ?? false;

		const accountId = sessionState.currentId
			? findSession(sessionState.currentId)?.accountId
			: getEffectiveInstanceId();
		return instances.some((instance) => instance.id === accountId);
	}

	/** The app-wide banners, health warning first. Reactive inside $derived. */
	export function appBanners(): BannerConfig[] {
		const banners = instanceWarningShown() ? [INSTANCE_WARNING, ...uiState.banners] : [...uiState.banners];
		const sessionId = sessionState.currentId;
		const session = sessionId ? findSession(sessionId) : undefined;
		const accountId = sessionId ? session?.accountId : getEffectiveInstanceId();
		const instances = getCachedInstances();
		const instance = instances.find((candidate) => candidate.id === accountId);
		// Older relays publish their first OpenCode runtime under the managed
		// transport alias. Prefer the account's own status whenever it is present.
		const aliasedInstance = instances.find((candidate) => getInstanceTraits(candidate.id)?.runsOpenCodeServer);
		const status =
			sessionId && getInstanceTraits(instance?.id)?.runsOpenCodeServer && accountId
				? uiState.opencodeConnections[accountId] ??
					(accountId === aliasedInstance?.id ? uiState.opencodeConnections[MANAGED_OPENCODE_ACCOUNT_ID] : undefined)
				: undefined;
		if (status === "starting") {
			banners.push({
				id: "opencode-connection-status",
				variant: "info",
				icon: "loader",
				text: "Starting OpenCode\u2026",
				dismissible: false,
			});
		} else if (status === "reconnecting" || status === "failed") {
			banners.push({
				id: "opencode-connection-status",
				variant: "warning",
				icon: "alert-triangle",
				text: status === "reconnecting" ? "Reconnecting to OpenCode\u2026" : "OpenCode failed to start",
				summary: status === "reconnecting" ? "OpenCode reconnecting\u2026" : "OpenCode failed",
				dismissible: false,
			});
		}
		return banners;
	}

	export function bannerTone(variant: BannerConfig["variant"]): string {
		switch (variant) {
			case "update":
				return "text-success";
			case "onboarding":
				return "text-accent";
			case "skip-permissions":
			case "error":
				return "text-error";
			case "warning":
				return "text-warning";
			case "info":
				return "text-text-muted";
			default:
				return assertNever(variant);
		}
	}
</script>

<script lang="ts">
	import { removeBanner } from "../../stores/ui.svelte.js";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";

	let { banners, ondismiss = removeBanner, presentation = "default" }: {
		banners?: BannerConfig[];
		ondismiss?: (id: string) => void;
		presentation?: "default" | "session-header";
	} = $props();
	const visibleBanners = $derived(banners ?? appBanners());

	function getVariantClasses(variant: BannerConfig["variant"]): string {
		if (presentation === "session-header") {
			switch (variant) {
				case "update": return "bg-success/14";
				case "onboarding": return "bg-accent/14";
				case "skip-permissions":
				case "error": return "bg-error/14";
				case "warning": return "bg-status-ask/14";
				case "info": return "bg-chip";
				default: return assertNever(variant);
			}
		}
		switch (variant) {
			case "update":
				return "bg-success/[0.08] border-success/30";
			case "onboarding":
				return "bg-accent-bg border-accent/30";
			case "skip-permissions":
			case "error":
				return "bg-error/10 border-error/30";
			case "warning":
				return "bg-warning-bg border-warning/30";
			case "info":
				return "bg-bg-alt border-border";
			default:
				return assertNever(variant);
		}
	}
</script>

{#if visibleBanners.length > 0}
	<div class="banners flex flex-col">
		{#each visibleBanners as banner (banner.id)}
			{@const leadEnd = banner.text.indexOf(". ")}
			<div
				class="banner flex items-center {presentation === 'session-header' ? 'min-h-[34px] gap-[8px] pl-[20px] pr-[12px] py-[5px] text-[12.5px] text-text' : `gap-2 px-4 py-2 text-xs border-b ${bannerTone(banner.variant)}`} {getVariantClasses(banner.variant)}"
				data-banner-id={banner.id}
				data-banner-variant={banner.variant}
			>
				<span class="banner-icon shrink-0 {presentation === 'session-header' ? bannerTone(banner.variant) : ''}">
					<Icon name={presentation === "session-header" && banner.variant === "skip-permissions" ? "lock" : banner.icon} size={presentation === "session-header" ? 16 : 14} />
				</span>
				<span class="banner-text flex-1 min-w-0">
					{#if presentation === "session-header" && leadEnd !== -1}<b class="font-semibold">{banner.text.slice(0, leadEnd + 1)}</b>{" "}{banner.text.slice(leadEnd + 2)}{:else}{banner.text}{/if}
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
				{#if banner.action}
					{#if presentation === "session-header"}
						<Button variant="secondary" size="content" tone="secondary" touchTarget class="h-[24px] shrink-0 rounded-[8px] px-[10px] text-[12px]" data-testid="banner-action" onclick={banner.action.run}>{banner.action.label}</Button>
					{:else}
					<TextButton
						type="button"
						tone="inherit"
						underline="always"
						class="shrink-0"
						data-testid="banner-action"
						onclick={banner.action.run}
					>
						{banner.action.label}
					</TextButton>
					{/if}
				{/if}
				{#if banner.dismissible}
					<!-- Inherit keeps the banner's own colour without adding a hover colour. -->
					<Button
						variant="ghost"
						size="content"
						tone="inherit"
						hoverFill="none"
						iconOnly
						icon="x"
						iconSize={14}
						class="banner-dismiss shrink-0 text-current opacity-60 hover:opacity-100 leading-none"
						title="Dismiss"
						ariaLabel="Dismiss"
						onclick={() => ondismiss(banner.id)}
					/>
				{/if}
			</div>
		{/each}
	</div>
{/if}
