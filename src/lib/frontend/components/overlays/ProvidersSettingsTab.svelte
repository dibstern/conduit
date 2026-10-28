<script lang="ts">
	import { tick } from "svelte";
	import type { OpenCodeInstance } from "../../types.js";
	import { getCachedInstances } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { usageState } from "../../stores/usage.svelte.js";
	import { PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";
	import HarnessLogo from "../model/HarnessLogo.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";

	let { onPageChange }: { onPageChange?: (page: { title: string; back: () => void } | null) => void } = $props();
	const drivers = ["claude", "codex", "cursor", "opencode"] as const;
	const groups = $derived(drivers.map((driver) => ({
		driver,
		label: PROVIDER_PRESENTATION[driver].label,
		accounts: getCachedInstances().filter((account) => (account.driver ?? "opencode") === driver),
	})));
	const accounts = $derived(groups.flatMap((group) => group.accounts));
	let selectedId = $state<string>();
	const selected = $derived(accounts.find((account) => account.id === selectedId) ?? accounts[0]);
	let detailPushed = $state(false);
	const phoneDetail = $derived(sessionViewState.compact && detailPushed && selected !== undefined);
	const plan = (account: OpenCodeInstance) => usageState.readings.find((reading) => reading.accountId === account.id)?.planLabel;
	const signedOut = (account: OpenCodeInstance) => account.driver === "codex" && account.unavailableCode === "auth_required";

	$effect(() => {
		if (selectedId !== selected?.id) selectedId = selected?.id;
		// Keep the phone title in sync with renames and removals from other clients.
		onPageChange?.(phoneDetail && selected ? { title: selected.name, back: () => void backToList() } : null);
	});

	async function backToList(): Promise<void> {
		const id = selected?.id;
		detailPushed = false;
		await tick();
		if (id) document.getElementById(`provider-account-${id}`)?.focus();
	}

	async function pick(account: OpenCodeInstance): Promise<void> {
		selectedId = account.id;
		if (!sessionViewState.compact) return;
		detailPushed = true;
		await tick();
		document.querySelector<HTMLElement>('[data-testid="settings-back-btn"]')?.focus();
	}

	function navigate(event: KeyboardEvent): void {
		if (!(event.target instanceof HTMLButtonElement)) return;
		const id = event.target.id;
		const index = accounts.findIndex((account) => `provider-account-${account.id}` === id);
		if (index < 0) return;
		const next = event.key === "ArrowDown" ? (index + 1) % accounts.length
			: event.key === "ArrowUp" ? (index + accounts.length - 1) % accounts.length
			: event.key === "Home" ? 0 : event.key === "End" ? accounts.length - 1 : undefined;
		if (next === undefined) return;
		event.preventDefault();
		document.getElementById(`provider-account-${accounts[next]?.id}`)?.focus();
	}

	function scrollFade(node: HTMLElement) {
		const update = () => { node.dataset["more"] = String(node.scrollHeight - node.clientHeight - node.scrollTop > 1); };
		const resize = new ResizeObserver(update);
		resize.observe(node);
		if (node.firstElementChild) resize.observe(node.firstElementChild);
		node.addEventListener("scroll", update, { passive: true });
		update();
		return { destroy() { resize.disconnect(); node.removeEventListener("scroll", update); } };
	}

	function subline(account: OpenCodeInstance): string {
		if ((account.driver ?? "opencode") === "opencode") return [
			account.port ? `:${account.port}` : null,
			account.isDefault ? "default" : null,
			!account.managed ? "discovered" : null,
			account.status === "stopped" ? "stopped" : null,
		].filter(Boolean).join(" · ");
		if (signedOut(account)) return "Not signed in";
		return [plan(account), account.isDefault ? "default" : null].filter(Boolean).join(" · ");
	}
</script>

<div data-testid="providers-settings" class="providers-split" class:phone={sessionViewState.compact}>
	{#if !phoneDetail}
		<section aria-label="Provider accounts" class="provider-column provider-list" data-more="false" use:scrollFade>
			<div class="grid gap-[10px]">
				{#each groups as group (group.driver)}
					<section aria-labelledby={`provider-heading-${group.driver}`} class="rounded-[12px] bg-settings-card px-[6px] pb-[6px]">
						<header class="provider-header sticky top-0 z-10 -mx-[6px] mb-[6px] flex h-[40px] items-center gap-[8px] rounded-t-[12px] border-b border-settings-separator bg-settings-card pl-[12px] pr-[8px] max-md:h-[44px]">
							<HarnessLogo driver={group.driver} size={18} />
							<h3 id={`provider-heading-${group.driver}`} class="text-[13px] font-semibold text-text max-md:text-[15px]">{group.label}</h3>
							<span data-testid="provider-account-count" aria-label={`${group.accounts.length} ${group.driver === 'opencode' ? 'servers' : 'accounts'}`} class="font-mono text-[11px] text-text-dimmer">{group.accounts.length}</span>
						</header>
						{#each group.accounts as account (account.id)}
							<Button
								id={`provider-account-${account.id}`}
								data-testid={`provider-account-${account.id}`}
								variant="provider-row" size="content" align="start"
								ariaLabel={`${group.label} ${group.driver === 'opencode' ? 'server' : 'account'} ${account.name}`}
								aria-pressed={selected?.id === account.id}
								tabindex={selected?.id === account.id ? 0 : -1}
								onkeydown={navigate}
								onclick={() => void pick(account)}
							>
								{#if group.driver === "opencode"}
									<span aria-label={account.status} class="size-[7px] shrink-0 rounded-full {account.status === 'healthy' ? 'bg-success' : account.status === 'starting' ? 'bg-warning' : account.status === 'unhealthy' ? 'bg-error' : 'bg-text-dimmer'}"></span>
								{:else}
									<AccountDot instanceId={account.id} size={7} />
								{/if}
								<span class="min-w-0 flex-1">
									<span class="block truncate">{account.name}</span>
									<span class="block truncate text-[11.5px] max-md:text-[12.5px] {signedOut(account) ? 'text-warning' : 'text-text-dimmer'}">{subline(account)}</span>
								</span>
							</Button>
						{:else}
							<p class="px-[8px] py-[10px] text-[11.5px] text-text-dimmer max-md:text-[12.5px]">{group.driver === "cursor" ? "Cursor is not installed." : `No ${group.label} ${group.driver === 'opencode' ? 'servers' : 'accounts'} configured.`}</p>
						{/each}
					</section>
				{/each}
			</div>
		</section>
	{/if}
	{#if !sessionViewState.compact || phoneDetail}
		<section aria-label="Account detail" class="provider-column min-w-0" data-more="false" use:scrollFade>
			<div>
				{#if selected}
					{@const driver = selected.driver ?? "opencode"}
					<SettingsGroup testId="provider-account-hero">
						<div class="flex items-center gap-[12px] p-[14px]">
							<HarnessLogo {driver} instanceId={driver === 'opencode' ? undefined : selected.id} size={26} />
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-[8px]">
									<h3 class="min-w-0 break-words text-[15px] font-semibold text-text">{selected.name}</h3>
									{#if plan(selected) && !signedOut(selected)}<Badge variant="chip" class="font-mono">{plan(selected)}</Badge>{/if}
									{#if selected.isDefault}<Badge variant="neutral">default</Badge>{/if}
									{#if driver === "opencode"}<Badge variant={selected.status === 'healthy' ? 'success' : selected.status === 'unhealthy' ? 'error' : selected.status === 'starting' ? 'warning' : 'neutral'}>{selected.status}</Badge>{/if}
								</div>
								<p class="mt-[2px] break-words text-[12px] text-text-dimmer">
									{#if driver === "opencode"}
										{selected.port ? `:${selected.port} · ` : ""}{selected.managed ? "started by conduit" : "discovered"}
									{:else}
										<code>{selected.configDir || (driver === "codex" ? "Automatic Codex home" : driver === "claude" ? "env" : "Default Cursor config")}</code> · {driver === "claude" ? "Claude Code login" : driver === "codex" ? "Codex login" : "Cursor login"}
									{/if}
								</p>
							</div>
						</div>
					</SettingsGroup>
				{:else}
					<p class="p-[14px] text-text-dimmer">Pick or add an account to see its details.</p>
				{/if}
			</div>
		</section>
	{/if}
</div>

<style>
	.providers-split {
		display: grid;
		grid-template-columns: 248px minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		gap: 16px;
		height: var(--providers-split-height, 486px);
		min-height: 0;
	}
	.provider-column { overflow-y: auto; scrollbar-width: thin; }
	.provider-column:global([data-more="true"]) { mask-image: linear-gradient(to bottom, black calc(100% - 24px), transparent); }
	.phone.providers-split { display: block; height: auto; }
	.phone .provider-column { overflow: visible; }
</style>
