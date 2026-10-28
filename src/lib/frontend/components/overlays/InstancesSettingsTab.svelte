<script lang="ts">
	import { isKnownDriverKind, type KnownProviderDriverKind } from "../../../contracts/provider-instance.js";
	import { onDestroy } from "svelte";
	import type { ServerForm } from "./ServerSettingsTab.svelte";
	import CursorAuthSettings from "./CursorAuthSettings.svelte";
	import CodexAuthSettings from "./CodexAuthSettings.svelte";
	import AccountForm from "./AccountForm.svelte";
	import { createAccountForm } from "./account-form.svelte.js";
	import { createAccountActions } from "../../utils/account-actions.svelte.js";
	import type { OpenCodeInstance } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import HarnessLogo from "../model/HarnessLogo.svelte";
	import Icon from "../ui/Icon.svelte";
	import ConduitMark from "../ui/ConduitMark.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import { getCachedInstances, getDriverTraits, getInstanceTraits, getProxyDetection, getScanResult, instanceStatusColor, isScanInFlight } from "../../stores/instance.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { getProviderPresentation, PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";

	const INSTANCE_KEY_COPY_FEEDBACK_MS = 2_000;
	let { openForm, onToggleForm, onOpenUsage }: { openForm: ServerForm | null; onToggleForm: (form: ServerForm) => void; onOpenUsage: () => void } = $props();
	const instanceFormMode = $derived(openForm === "instance-add" ? "add" : openForm?.startsWith("instance-edit:") ? "edit" : null);

	let state = $state({
		expandedInstanceId: null as string | null,
		expandedScenario: null as string | null,
		guidesOpen: false,
		copiedKey: null as string | null,
		copyTimer: null as ReturnType<typeof setTimeout> | null,
	});

	const accountActions = createAccountActions();
	const form = createAccountForm({
		onclose: (target) => {
			const key = target.mode === "edit" ? `instance-edit:${target.accountId}` as const : "instance-add";
			if (openForm !== key) return;
			if (target.mode === "edit") state.expandedInstanceId = null;
			onToggleForm(key);
		},
	});
	$effect(() => { void accountActions.detectProxy(); });
	onDestroy(() => {
		if (state.copyTimer) clearTimeout(state.copyTimer);
	});
	const DRIVER_OPTIONS = Object.keys(PROVIDER_PRESENTATION).filter(isKnownDriverKind);
	const instances = $derived(getCachedInstances());
	const instancesByDriver = $derived.by(() => {
		const grouped: Record<string, typeof instances> = {};
		for (const instance of instances) {
			const driver = instance.driver ?? "opencode";
			if (!isKnownDriverKind(driver)) continue;
			(grouped[driver] ??= []).push(instance);
		}
		return grouped;
	});
	const configDirectoryDrivers = $derived(DRIVER_OPTIONS.filter((driver) => {
		const traits = getDriverTraits(driver);
		return traits?.accountKind === "config-directory";
	}));
	const serverInstances = $derived(instances.filter((inst) => getProviderPresentation(inst.driver ?? "opencode") && getInstanceTraits(inst.id)?.runsOpenCodeServer));
	const unknownInstances = $derived(instances.filter((inst) => !getProviderPresentation(inst.driver ?? "opencode")));
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);
	function handleToggleInstance(instanceId: string) {
		state.expandedInstanceId = state.expandedInstanceId === instanceId ? null : instanceId;
	}
	function openAddInstance(driver: KnownProviderDriverKind = "claude") {
		if (openForm === "instance-add") { form.close(); return; }
		form.close();
		form.openAdd(driver);
		onToggleForm("instance-add");
	}
	function openEditInstance(inst: OpenCodeInstance) {
		if (openForm === `instance-edit:${inst.id}`) { form.close(); return; }
		form.openEdit(inst);
		onToggleForm(`instance-edit:${inst.id}`);
	}
	async function handleCopy(text: string, key: string) {
		const ok = await copyToClipboard(text);
		if (ok) {
			state.copiedKey = key;
			if (state.copyTimer) clearTimeout(state.copyTimer);
			state.copyTimer = setTimeout(() => { state.copiedKey = null; state.copyTimer = null; }, INSTANCE_KEY_COPY_FEEDBACK_MS);
		} else { showToast("Failed to copy — clipboard unavailable", { variant: "warn" }); }
	}
	function toggleScenario(id: string) { state.expandedScenario = state.expandedScenario === id ? null : id; }
</script>

{#snippet cmdBlock(cmd: string, key: string)}
	<div class="group/cmd flex items-start gap-1.5 bg-bg-alt rounded px-2.5 py-1.5 font-mono text-xs text-text leading-relaxed">
		<span class="flex-1 whitespace-pre-wrap break-all select-all">{cmd}</span>
		<TextButton type="button" class="max-md:min-h-[44px] max-md:min-w-[44px] shrink-0 p-0.5 opacity-0 group-hover/cmd:opacity-100 transition-opacity" title="Copy" aria-label="Copy" onclick={() => handleCopy(cmd, key)}>
			{#if state.copiedKey === key}<Icon name="check" size={13} class="text-success" />{:else}<Icon name="copy" size={13} />{/if}
		</TextButton>
	</div>
{/snippet}


<div id="instances-settings" class="mt-[16px] flex flex-col gap-[6px]">
<div class="flex items-center justify-between gap-[10px]">
	<h3 class="px-[4px] text-[12px] font-medium text-text-muted max-md:text-[13px]">Instances</h3>
	<div class="flex items-center gap-2">
	<Button touchTarget
		variant="secondary"
		size="sm"
		data-testid="scan-now-btn"
		disabled={scanInFlight}
		onclick={() => void accountActions.scan()}
	>
		{#if scanInFlight}<ConduitMark size={12} variant="running" tone="inherit" />{:else}<Icon name="refresh-cw" size={12} />{/if}
		{scanInFlight ? "Scanning..." : "Scan"}
	</Button>
	<Button touchTarget
		variant="secondary"
		size="sm"
		data-testid="add-instance-btn"
		aria-expanded={openForm === "instance-add"}
		aria-controls="instance-form"
		disabled={form.state.formSaving}
		onclick={() => openAddInstance()}
	>
		<Icon name="plus" size={12} />
		Add
	</Button>
	</div>
</div>

{#if instanceFormMode !== null}
	<AccountForm {form} />
{/if}

<div id="instance-settings-list" class="flex flex-col">
	{#each configDirectoryDrivers as driver (driver)}
		{@const accounts = instancesByDriver[driver] ?? []}
		{@const presentation = PROVIDER_PRESENTATION[driver]}
		{#if presentation.auth}
			{#each accounts as account (account.id)}
				<CursorAuthSettings {account} />
			{:else}
				<CursorAuthSettings />
			{/each}
		{:else if accounts.length > 0}
			<SettingsGroup title="{presentation.label} accounts" testId="{driver}-accounts-list">
				{#snippet actions()}
					{#if getDriverTraits(driver)?.usageHarness && accounts.some((account) => account.usageEligible !== false)}
						<span class="flex flex-wrap items-center justify-end gap-1 text-[12px] text-text-muted">
							<span>Usage and switch order: </span>
							<TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" tone="accent" data-testid="{driver}-accounts-usage-link" onclick={onOpenUsage}>Usage ›</TextButton>
						</span>
					{/if}
				{/snippet}
				{#each accounts as inst (inst.id)}
					<div data-testid="instance-row-{inst.id}" data-driver={driver}>
						<Disclosure expanded={state.expandedInstanceId === inst.id} onToggle={() => handleToggleInstance(inst.id)} look="row" density="row" chevron={false} class="focus-visible:-outline-offset-2">
							<HarnessLogo {driver} instanceId={inst.id} size={18} aligned data-testid="account-logo" />
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-[6px] text-[13.5px] max-md:text-[15px] text-text">
									<span class="truncate">{inst.name}</span>
									{#if inst.isDefault}<Badge variant="quiet" size="xs" shape="pill" data-testid="default-account-marker">default</Badge>{/if}
								</div>
								<div class="font-mono text-[12px] leading-[1.35] text-text-muted truncate">{inst.configDir || (driver === "codex" ? "Automatic Codex home" : "env")}</div>
							</div>
							<span aria-hidden="true" class="w-[10px] shrink-0 text-center not-italic text-text-muted transition-transform duration-150" class:rotate-90={state.expandedInstanceId === inst.id}>›</span>
						</Disclosure>
						{#if state.expandedInstanceId === inst.id}
							<div class="flex flex-col gap-[8px] border-t border-settings-separator pt-[9px] pb-[10px] pr-[12px] pl-[40px] max-md:pl-[12px]">
								{#if driver === "codex"}<CodexAuthSettings accountId={inst.id} />{/if}
								<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[14px] gap-y-[3px] text-[12px] [&_dd]:truncate">
									<dt class="text-text-muted">Config dir</dt>
									<dd class="font-mono text-text">{inst.configDir || (driver === "codex" ? "Automatic Codex home" : "env")}</dd>
									<dt class="text-text-muted">Used by</dt>
									<dd class="text-text">{inst.isDefault ? "New sessions, unless you pick another account" : inst.usageEligible !== false && getDriverTraits(driver)?.usageHarness ? "Sessions you move to it, and auto-switch" : "Sessions you move to it"}</dd>
								</dl>
								<div class="flex flex-wrap items-center gap-2">
									<Button touchTarget variant="secondary" size="sm" data-testid="edit-instance-btn" disabled={form.state.formSaving} aria-expanded={openForm === `instance-edit:${inst.id}`} aria-controls="instance-form" onclick={() => openEditInstance(inst)}>Edit</Button>
									{#if !inst.isDefault}
										<Button touchTarget variant="secondary" size="sm" data-testid="make-default-btn" disabled={form.state.formSaving || accountActions.defaultSaving} onclick={() => accountActions.makeDefault(inst.id)}>Make default</Button>
									{/if}
									<Button touchTarget variant="danger-outline" size="sm" data-testid="remove-instance-btn" onclick={() => accountActions.remove(inst.id, inst.name)}>Remove</Button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</SettingsGroup>
		{:else}
			<SettingsGroup title="{presentation.label} accounts" testId="{driver}-empty-state">
				<div class="flex flex-wrap items-center justify-between gap-2 px-[14px] py-[10px] text-[12px] text-text-muted">
					<p>No {presentation.label} accounts yet.</p>
					<Button touchTarget variant="secondary" size="sm" data-testid="add-{driver}-account-settings-btn" disabled={form.state.formSaving} onclick={() => openAddInstance(driver)}>Add account</Button>
				</div>
			</SettingsGroup>
		{/if}
	{/each}
	<SettingsGroup title="{PROVIDER_PRESENTATION.opencode.label} servers" testId="opencode-servers-list">
		{#snippet actions()}
			{#if serverInstances.length > 0}<span class="text-[12px] text-text-muted">{serverInstances.length}</span>{/if}
		{/snippet}
		{#each serverInstances as inst (inst.id)}
			<div data-testid="instance-row-{inst.id}" data-driver={inst.driver ?? "opencode"}>
				<Disclosure expanded={state.expandedInstanceId === inst.id} onToggle={() => handleToggleInstance(inst.id)} look="row" density="row" chevron={false} class="focus-visible:-outline-offset-2">
					<HarnessLogo driver={inst.driver ?? "opencode"} instanceId={inst.id} size={18} aligned data-testid="account-logo" />
					<div class="flex-1 min-w-0 flex items-center gap-[6px] text-[13.5px] max-md:text-[15px] text-text">
						<span class="truncate">{inst.name}</span>
						{#if inst.isDefault}<Badge variant="quiet" size="xs" shape="pill" data-testid="default-account-marker">default</Badge>{/if}
						{#if !inst.managed}<Badge variant="quiet" size="xs" shape="pill">discovered</Badge>{/if}
					</div>
					<span data-testid="instance-status-dot" class={"size-[7px] rounded-full shrink-0 " + instanceStatusColor(inst.status)}></span>
					<span class="font-mono text-[12px] text-text-muted shrink-0">:{inst.port}</span>
					<span aria-hidden="true" class="w-[10px] shrink-0 text-center not-italic text-text-muted transition-transform duration-150" class:rotate-90={state.expandedInstanceId === inst.id}>›</span>
				</Disclosure>
				{#if state.expandedInstanceId === inst.id}
					<div class="flex flex-col gap-[8px] border-t border-settings-separator pt-[9px] pb-[10px] pr-[12px] pl-[40px] max-md:pl-[12px]">
						<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[14px] gap-y-[3px] text-[12px] [&_dd]:truncate">
							<dt class="text-text-muted">Status</dt>
							<dd class="text-text capitalize">{inst.status}</dd>
							<dt class="text-text-muted">Address</dt>
							<dd class="font-mono text-text">{inst.url ?? `http://127.0.0.1:${inst.port}`}</dd>
							<dt class="text-text-muted">Started by</dt>
							<dd class="text-text">{inst.managed ? "Conduit" : "You (found by scan)"}</dd>
						</dl>
						<div class="flex flex-wrap items-center gap-2">
							{#if !inst.isDefault}
								<Button touchTarget variant="secondary" size="sm" data-testid="make-default-btn" disabled={form.state.formSaving || accountActions.defaultSaving} onclick={() => accountActions.makeDefault(inst.id)}>Make default</Button>
							{/if}
							{#if inst.managed}
								{#if inst.status === "healthy" || inst.status === "starting"}
									<Button touchTarget variant="secondary" size="sm" onclick={() => accountActions.stop(inst.id)}>Stop</Button>
								{:else}
									<Button touchTarget variant="secondary" size="sm" onclick={() => accountActions.start(inst.id)}>Start</Button>
								{/if}
							{/if}
							<Button touchTarget variant="secondary" size="sm" data-testid="edit-instance-btn" disabled={form.state.formSaving} aria-expanded={openForm === `instance-edit:${inst.id}`} aria-controls="instance-form" onclick={() => openEditInstance(inst)}>Edit</Button>
							<Button touchTarget variant="danger-outline" size="sm" data-testid="remove-instance-btn" onclick={() => accountActions.remove(inst.id, inst.name)}>Remove</Button>
						</div>
					</div>
				{/if}
			</div>
		{:else}
			<div class="px-3 py-2 flex flex-col gap-2 text-xs text-text-muted" data-testid="opencode-empty-state">
				<p>No OpenCode servers yet. Start one and it shows up here, or <TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" type="button" tone="accent" data-testid="scan-now-link" disabled={scanInFlight} onclick={() => void accountActions.scan()}>{scanInFlight ? "Scanning..." : "scan now"}</TextButton>.</p>
					{@render cmdBlock("opencode serve --port 4098", "empty-serve")}
				<SettingsGroup title="Setup guides" collapsible bind:open={state.guidesOpen} summary={`Direct key · CCS${ccsDetected ? " ✓" : ""} · Custom${proxyResult === null ? " · detecting..." : ""}`} testId="opencode-setup-guides">
					<div>
						<Disclosure expanded={state.expandedScenario === "direct"} onToggle={() => toggleScenario("direct")} chevron={false} look="section" density="list">
							<Icon name={state.expandedScenario === "direct" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
							<span>Direct key</span>
						</Disclosure>
						{#if state.expandedScenario === "direct"}
							<div class="p-[8px] flex flex-col gap-[6px] border-t border-settings-separator">
								<p>1. Start an OpenCode server:</p>
								{@render cmdBlock("opencode serve --port 4098", "direct-1")}
								<p>2. Configure your provider:</p>
								{@render cmdBlock("opencode config set provider anthropic\nopencode config set anthropic.apiKey sk-ant-...", "direct-2")}
								<p class="italic">It will appear here automatically.</p>
							</div>
						{/if}
					</div>
					<div>
						<Disclosure expanded={state.expandedScenario === "ccs"} onToggle={() => toggleScenario("ccs")} chevron={false} look="section" density="list">
							<Icon name={state.expandedScenario === "ccs" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
							<span>CCS</span>
							{#if ccsDetected}<Icon name="circle-check" size={14} class="text-success ml-auto shrink-0" />{:else if proxyResult === null}<span class="ml-auto flex items-center gap-1.5 text-xs text-text-muted"><ConduitMark size={12} variant="running" />detecting...</span>{/if}
						</Disclosure>
						{#if state.expandedScenario === "ccs"}
							<div class="p-[8px] flex flex-col gap-[6px] border-t border-settings-separator">
								<p>CCS manages OAuth tokens and API keys for 20+ providers.</p>
								{#if ccsDetected}
									<div class="flex items-center gap-1.5 text-xs text-success bg-success/10 rounded px-2 py-1"><Icon name="circle-check" size={12} />CCS detected on port {proxyResult?.port ?? 8317}</div>
								{/if}
								<p>1. Install CCS:</p>
								{@render cmdBlock("npm install -g @anthropic-ai/ccs", "ccs-1")}
								<p>2. Authenticate:</p>
								{@render cmdBlock("ccs claude --auth", "ccs-2")}
								<p>3. Start proxy:</p>
								{@render cmdBlock("ccs cliproxy start", "ccs-3")}
								<p>4. Start OpenCode:</p>
								{@render cmdBlock('ANTHROPIC_API_KEY="ccs-internal-managed" \\\n  ANTHROPIC_BASE_URL="http://127.0.0.1:8317/api/provider/claude/v1" \\\n  opencode serve --port 4098', "ccs-4")}
							</div>
						{/if}
					</div>
					<div>
						<Disclosure expanded={state.expandedScenario === "custom"} onToggle={() => toggleScenario("custom")} chevron={false} look="section" density="list">
							<Icon name={state.expandedScenario === "custom" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
							<span>Custom</span>
						</Disclosure>
						{#if state.expandedScenario === "custom"}
							<div class="p-[8px] flex flex-col gap-[6px] border-t border-settings-separator">
								<p>Configure with environment variables:</p>
								{@render cmdBlock("ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098", "custom-1")}
							</div>
						{/if}
					</div>
				</SettingsGroup>
			</div>
		{/each}
	</SettingsGroup>
	{#if unknownInstances.length > 0}
		<SettingsGroup title="Other accounts" testId="unknown-accounts-list">
			{#each unknownInstances as inst (inst.id)}
				<div data-testid="instance-row-{inst.id}" data-driver={inst.driver}>
					<Disclosure expanded={state.expandedInstanceId === inst.id} onToggle={() => handleToggleInstance(inst.id)} look="row" density="row" chevron={false} class="focus-visible:-outline-offset-2">
						<HarnessLogo driver={inst.driver ?? "opencode"} instanceId={inst.id} size={18} aligned data-testid="account-logo" />
						<div class="flex-1 min-w-0">
							<div class="truncate text-[13.5px] max-md:text-[15px] text-text">{inst.name}</div>
							<div class="text-[12px] text-text-muted">Unknown provider</div>
						</div>
						<span aria-hidden="true" class="w-[10px] shrink-0 text-center not-italic text-text-muted transition-transform duration-150" class:rotate-90={state.expandedInstanceId === inst.id}>›</span>
					</Disclosure>
					{#if state.expandedInstanceId === inst.id}
						<div class="flex flex-col gap-[8px] border-t border-settings-separator pt-[9px] pb-[10px] pr-[12px] pl-[40px] max-md:pl-[12px]">
							<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[14px] gap-y-[3px] text-[12px] [&_dd]:truncate">
								<dt class="text-text-muted">Driver</dt>
								<dd class="font-mono text-text">{inst.driver}</dd>
								<dt class="text-text-muted">Status</dt>
								<dd class="text-text capitalize">{inst.status}</dd>
								{#if inst.configDir}<dt class="text-text-muted">Config dir</dt><dd class="font-mono text-text">{inst.configDir}</dd>{/if}
								{#if inst.url}<dt class="text-text-muted">Address</dt><dd class="font-mono text-text">{inst.url}</dd>{/if}
							</dl>
							<div class="flex flex-wrap items-center gap-2">
								<Button touchTarget variant="danger-outline" size="sm" data-testid="remove-instance-btn" onclick={() => accountActions.remove(inst.id, inst.name)}>Remove</Button>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</SettingsGroup>
	{/if}
</div>

{#if scanResult && !scanInFlight}
	<p class="text-[12px] text-text-muted" data-testid="instance-scan-note" role="status">
		{#if scanResult.discovered.length > 0}
			Found {scanResult.discovered.length} new instance{scanResult.discovered.length !== 1 ? "s" : ""} on port{scanResult.discovered.length !== 1 ? "s" : ""} {scanResult.discovered.join(", ")}.
		{:else if scanResult.lost.length > 0}
			{scanResult.lost.length} instance{scanResult.lost.length !== 1 ? "s" : ""} lost (port{scanResult.lost.length !== 1 ? "s" : ""} {scanResult.lost.join(", ")}).
		{:else if scanResult.active.length > 0}
			{scanResult.active.length} active instance{scanResult.active.length !== 1 ? "s" : ""} on port{scanResult.active.length !== 1 ? "s" : ""} {scanResult.active.join(", ")} (no changes).
		{:else}
			No active instances found.
		{/if}
	</p>
{/if}
</div>
