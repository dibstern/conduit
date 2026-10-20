<script lang="ts">
	import { isKnownDriverKind, type KnownProviderDriverKind } from "../../../contracts/provider-instance.js";
	import { onDestroy } from "svelte";
	import type { ServerForm } from "./ServerSettingsTab.svelte";
	import CursorAuthSettings from "./CursorAuthSettings.svelte";
	import { refreshServerStatus } from "../../stores/server-status.svelte.js";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import Icon from "../ui/Icon.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import { applyDetectProxyResponse, applyInstanceListResponse, applyScanNowResponse, beginProxyDetection, beginScan, clearScanInFlight, getCachedInstances, getDriverTraits, getInstanceTraits, getProxyDetection, getScanResult, instanceStatusColor, isScanInFlight } from "../../stores/instance.svelte.js";
	import { confirm, showToast } from "../../stores/ui.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { getProviderPresentation, PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";

	const INSTANCE_KEY_COPY_FEEDBACK_MS = 2_000;
	let { openForm, onToggleForm, onOpenUsage }: { openForm: ServerForm | null; onToggleForm: (form: ServerForm) => void; onOpenUsage: () => void } = $props();
	const instanceFormMode = $derived(openForm === "instance-add" ? "add" : openForm?.startsWith("instance-edit:") ? "edit" : null);
	const editingInstanceId = $derived(instanceFormMode === "edit" ? openForm?.slice("instance-edit:".length) : null);

	let state = $state({
		expandedInstanceId: null as string | null,
		expandedScenario: null as string | null,
		guidesOpen: false,
		copiedKey: null as string | null,
		copyTimer: null as ReturnType<typeof setTimeout> | null,
		formDriver: "claude" as KnownProviderDriverKind,
		formName: "",
		formConfigDir: "",
		formManaged: true,
		formPort: "",
		formUrl: "",
		formEnv: "",
		initialFormEnv: "",
		formEnvOpen: false,
		formSaving: false,
		defaultSaving: false,
	});

	$effect(() => {
		beginProxyDetection();
		void rpc("DetectProxy", {})
			.then(applyDetectProxyResponse)
			.catch(() => applyDetectProxyResponse({ found: false, port: 8317 }));
	});
	onDestroy(() => {
		if (state.copyTimer) clearTimeout(state.copyTimer);
	});
	const DRIVER_OPTIONS = Object.keys(PROVIDER_PRESENTATION).filter(isKnownDriverKind);
	const DRIVER_TAB_OPTIONS = $derived(DRIVER_OPTIONS.map((driver) => ({
		value: driver,
		label: `${PROVIDER_PRESENTATION[driver].label} ${getDriverTraits(driver)?.accountKind === "config-directory" ? "account" : "server"}`,
		testId: `instance-form-driver-${driver}`,
	})));
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
	const formTraits = $derived(getDriverTraits(state.formDriver));
	const formPresentation = $derived(PROVIDER_PRESENTATION[state.formDriver]);
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);
	function handleToggleInstance(instanceId: string) {
		state.expandedInstanceId = state.expandedInstanceId === instanceId ? null : instanceId;
	}
	function handleStart(instanceId: string) {
		void rpc("StartInstance", { instanceId })
			.then(applyInstanceListResponse)
			.then(refreshServerStatus)
			.catch(toastFailure("Failed to start instance", "warn"));
	}
	function handleStop(instanceId: string) {
		void rpc("StopInstance", { instanceId })
			.then(applyInstanceListResponse)
			.then(refreshServerStatus)
			.catch(toastFailure("Failed to stop instance", "warn"));
	}
	async function handleMakeDefault(instanceId: string) {
		if (state.defaultSaving) return;
		state.defaultSaving = true;
		try {
			applyInstanceListResponse(await rpc("SetDefault", { instanceId }));
		} catch (error: unknown) {
			toastFailure("Failed to change default account", "warn")(error);
		} finally {
			state.defaultSaving = false;
		}
	}
	async function handleRemove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(`Remove instance "${instanceName}"? This cannot be undone.`);
		if (confirmed) {
			void rpc("RemoveInstance", { instanceId })
				.then(applyInstanceListResponse)
				.then(refreshServerStatus)
				.catch(toastFailure("Failed to remove instance", "warn"));
		}
	}
	function closeInstanceForm() {
		if (instanceFormMode === "edit") state.expandedInstanceId = null;
		if (instanceFormMode !== null && openForm) onToggleForm(openForm);
		state.formDriver = "claude";
		state.formName = "";
		state.formConfigDir = "";
		state.formManaged = true;
		state.formPort = "";
		state.formUrl = "";
		state.formEnv = "";
		state.initialFormEnv = "";
		state.formEnvOpen = false;
		state.formSaving = false;
	}
	function openAddInstance(driver: KnownProviderDriverKind = "claude") {
		if (openForm === "instance-add") { closeInstanceForm(); return; }
		closeInstanceForm();
		state.formDriver = driver;
		onToggleForm("instance-add");
	}
	function openEditInstance(inst: {
		id: string;
		name: string;
		driver?: string;
		port?: number;
		configDir?: string;
		managed?: boolean;
		url?: string;
		env?: Record<string, string>;
	}) {
		if (openForm === `instance-edit:${inst.id}`) { closeInstanceForm(); return; }
		state.formDriver = isKnownDriverKind(inst.driver) ? inst.driver : "opencode";
		state.formName = inst.name;
		state.formConfigDir = inst.configDir ?? "";
		state.formManaged = inst.managed ?? false;
		state.formPort = inst.port ? String(inst.port) : "";
		state.formUrl = inst.url ?? `http://127.0.0.1:${inst.port}`;
		state.formEnvOpen = false;
		state.formEnv = inst.env
			? Object.entries(inst.env)
					.map(([k, v]) => `${k}=${v}`)
					.join("\n")
			: "";
		state.initialFormEnv = state.formEnv;
		onToggleForm(`instance-edit:${inst.id}`);
	}
	/** Parse `KEY=VALUE` lines into an env record; blank/`#` lines are ignored. */
	function parseEnv(text: string): Record<string, string> | undefined {
		const env: Record<string, string> = {};
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		}
		return Object.keys(env).length > 0 ? env : undefined;
	}
	function submitInstanceForm() {
		if (state.formSaving || instanceFormMode === null) return;
		const name = state.formName.trim();
		if (!name) {
			showToast("Instance name is required", { variant: "warn" });
			return;
		}
		const usesConfigDirectory = formTraits?.accountKind === "config-directory";
		const endpoint = state.formUrl.trim();
		const portText = state.formManaged ? state.formPort.trim() : /^\d+$/.test(endpoint) ? endpoint : "";
		const port = portText ? Number(portText) : undefined;
		if (formTraits?.runsOpenCodeServer && port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
			showToast("Port must be a whole number between 1 and 65535", { variant: "warn" });
			return;
		}
		if (formTraits?.runsOpenCodeServer && !state.formManaged && !endpoint) {
			showToast("URL is required", { variant: "warn" });
			return;
		}
		const env = (formTraits?.runsOpenCodeServer && state.formManaged) || formPresentation.environment ? parseEnv(state.formEnv) : undefined;
		const configEnv = formPresentation.environment && state.formEnv !== state.initialFormEnv ? { env: env ?? {} } : {};
		const configDir = state.formConfigDir.trim() || undefined;
		const url = !state.formManaged && port === undefined ? endpoint || undefined : undefined;
		state.formSaving = true;
		const request =
			instanceFormMode === "edit" && editingInstanceId
				? rpc("UpdateInstance", {
						instanceId: editingInstanceId,
						name,
						...(usesConfigDirectory
							? { configDir: configDir ?? "", ...configEnv }
							: state.formManaged ? { ...(port !== undefined ? { port } : {}), env: env ?? {} } : {}),
					})
				: rpc("AddInstance", {
						name,
						driver: state.formDriver,
						...(usesConfigDirectory
							? {
									managed: false,
									...(configDir !== undefined ? { configDir } : {}),
									...configEnv,
								}
							: {
									managed: state.formManaged,
									...(port !== undefined ? { port } : {}),
									...(url !== undefined ? { url } : {}),
									...(env !== undefined ? { env } : {}),
								}),
					});
		const submittedForm = openForm;
		void request
			.then(async (response) => {
				applyInstanceListResponse(response);
				await refreshServerStatus();
				state.formSaving = false;
				if (openForm === submittedForm) closeInstanceForm();
			})
			.catch((error: unknown) => {
				state.formSaving = false;
				toastFailure(`Failed to ${submittedForm?.startsWith("instance-edit:") ? "update" : "add"} instance`, "warn")(error);
			});
	}
	function handleScanNow() {
		beginScan();
		void rpc("ScanNow", {})
			.then(applyScanNowResponse)
			.then(refreshServerStatus)
			.catch((error) => {
				clearScanInFlight();
				toastFailure("Port scan failed", "warn")(error);
			});
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
		onclick={handleScanNow}
	>
		<Icon name="refresh-cw" size={12} class={scanInFlight ? "animate-spin" : ""} />
		{scanInFlight ? "Scanning..." : "Scan"}
	</Button>
	<Button touchTarget
		variant="secondary"
		size="sm"
		data-testid="add-instance-btn"
		aria-expanded={openForm === "instance-add"}
		aria-controls="instance-form"
		disabled={state.formSaving}
		onclick={() => openAddInstance()}
	>
		<Icon name="plus" size={12} />
		Add
	</Button>
	</div>
</div>

{#if instanceFormMode !== null}
	<SettingsGroup>
	<form id="instance-form" class="px-[14px] py-3 flex flex-col gap-3" data-server-form data-testid="instance-form" aria-label={instanceFormMode === "edit" ? "Edit instance" : "New instance"} novalidate onsubmit={(event) => { event.preventDefault(); submitInstanceForm(); }}>
		<div class="flex flex-wrap items-center gap-[10px] text-[13.5px] max-md:text-[15px]">
			<h4 class="font-semibold text-text">{instanceFormMode === "edit" ? `Edit ${instances.find((inst) => inst.id === editingInstanceId)?.name ?? "instance"}` : "New instance"}</h4>
			{#if instanceFormMode === "add"}
				<SegmentedControl bind:value={state.formDriver} label="Type" options={DRIVER_TAB_OPTIONS} variant="joined" class="max-w-full" />
			{/if}
		</div>
		{#if formTraits?.runsOpenCodeServer}
			<SettingsRow label="Conduit starts it" description="Off: connect to one you run" checked={state.formManaged} onchange={() => { state.formManaged = !state.formManaged; }} disabled={state.formSaving || instanceFormMode === "edit"} testId="instance-form-managed" class="p-0" />
		{/if}
		<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
			<label for="instance-form-name" class="flex flex-col gap-1 text-[12px] text-text-muted">
				Name
				<TextInput id="instance-form-name" data-testid="instance-form-name" placeholder={formPresentation.namePlaceholder} bind:value={state.formName} disabled={state.formSaving} required />
			</label>
			{#if formTraits?.accountKind === "config-directory"}
				<label for="instance-form-configdir" class="flex flex-col gap-1 text-[12px] text-text-muted">
					Config directory (optional)
					<TextInput id="instance-form-configdir" data-testid="instance-form-configdir" placeholder={formPresentation.configDirPlaceholder} bind:value={state.formConfigDir} disabled={state.formSaving} />
				</label>
			{:else if state.formManaged}
				<label for="instance-form-port" class="flex flex-col gap-1 text-[12px] text-text-muted">
					Port
					<TextInput id="instance-form-port" inputmode="numeric" data-testid="instance-form-port" placeholder="4098" bind:value={state.formPort} disabled={state.formSaving} />
				</label>
			{:else}
				<label for="instance-form-url" class="flex flex-col gap-1 text-[12px] text-text-muted">
					URL (or port)
					<TextInput id="instance-form-url" data-testid="instance-form-url" placeholder="http://127.0.0.1:4098" bind:value={state.formUrl} readonly={instanceFormMode === "edit"} disabled={state.formSaving} />
				</label>
			{/if}
		</div>
		{#if formTraits?.accountKind === "config-directory"}
			<p class="text-[12px] text-text-muted">Folder changes apply on the next turn. Leave the folder empty to use the login Conduit was launched with.</p>
		{/if}
		{#if formPresentation.environment || (formTraits?.runsOpenCodeServer && state.formManaged)}
			<SettingsGroup title="Environment variables" summary="KEY=VALUE per line" collapsible bind:open={state.formEnvOpen}>
				<label for="instance-form-env" class="block p-3">
					<span class="sr-only">Environment variables</span>
					<Textarea id="instance-form-env" data-testid="instance-form-env" rows={2} class="resize-y font-mono" placeholder={formPresentation.environment?.placeholder ?? "ANTHROPIC_API_KEY=sk-ant-..."} bind:value={state.formEnv} disabled={state.formSaving} />
					{#if formPresentation.environment}<p class="mt-2 text-[12px] leading-[1.5] text-text-dimmer">{formPresentation.environment.hint}</p>{/if}
				</label>
			</SettingsGroup>
		{/if}
		<div class="flex justify-end gap-1.5">
			<Button touchTarget variant="secondary" size="sm" data-testid="instance-form-cancel" disabled={state.formSaving} onclick={closeInstanceForm}>Cancel</Button>
			<Button touchTarget variant="primary" size="sm" type="submit" data-testid="instance-form-save" disabled={state.formSaving}>{state.formSaving ? "Saving..." : instanceFormMode === "edit" ? "Save" : "Add instance"}</Button>
		</div>
	</form>
	</SettingsGroup>
{/if}

<div id="instance-settings-list" class="flex flex-col">
	{#each configDirectoryDrivers as driver (driver)}
		{@const accounts = instancesByDriver[driver] ?? []}
		{@const presentation = PROVIDER_PRESENTATION[driver]}
		{#if presentation.auth}
			<CursorAuthSettings account={accounts[0]} />
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
							<AccountDot instanceId={inst.id} size={9} />
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-[6px] text-[13.5px] max-md:text-[15px] text-text">
									<span class="truncate">{inst.name}</span>
									{#if inst.isDefault}<Badge variant="quiet" size="xs" shape="pill" data-testid="default-account-marker">default</Badge>{/if}
								</div>
								<div class="font-mono text-[12px] leading-[1.35] text-text-muted truncate">{inst.configDir || "env"}</div>
							</div>
							<span aria-hidden="true" class="w-[10px] shrink-0 text-center not-italic text-text-muted transition-transform duration-150" class:rotate-90={state.expandedInstanceId === inst.id}>›</span>
						</Disclosure>
						{#if state.expandedInstanceId === inst.id}
							<div class="flex flex-col gap-[8px] border-t border-settings-separator pt-[9px] pb-[10px] pr-[12px] pl-[40px] max-md:pl-[12px]">
								<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[14px] gap-y-[3px] text-[12px] [&_dd]:truncate">
									<dt class="text-text-muted">Config dir</dt>
									<dd class="font-mono text-text">{inst.configDir || "env"}</dd>
									<dt class="text-text-muted">Used by</dt>
									<dd class="text-text">{inst.isDefault ? "New sessions, unless you pick another account" : inst.usageEligible !== false && getDriverTraits(driver)?.usageHarness ? "Sessions you move to it, and auto-switch" : "Sessions you move to it"}</dd>
								</dl>
								<div class="flex flex-wrap items-center gap-2">
									<Button touchTarget variant="secondary" size="sm" data-testid="edit-instance-btn" disabled={state.formSaving} aria-expanded={openForm === `instance-edit:${inst.id}`} aria-controls="instance-form" onclick={() => openEditInstance(inst)}>Edit</Button>
									{#if !inst.isDefault}
										<Button touchTarget variant="secondary" size="sm" data-testid="make-default-btn" disabled={state.formSaving || state.defaultSaving} onclick={() => handleMakeDefault(inst.id)}>Make default</Button>
									{/if}
									<Button touchTarget variant="danger-outline" size="sm" data-testid="remove-instance-btn" onclick={() => handleRemove(inst.id, inst.name)}>Remove</Button>
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
					<Button touchTarget variant="secondary" size="sm" data-testid="add-{driver}-account-settings-btn" disabled={state.formSaving} onclick={() => openAddInstance(driver)}>Add account</Button>
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
					<span data-testid="instance-status-dot" class={"size-[7px] rounded-full shrink-0 " + instanceStatusColor(inst.status)}></span>
					<div class="flex-1 min-w-0 flex items-center gap-[6px] text-[13.5px] max-md:text-[15px] text-text">
						<span class="truncate">{inst.name}</span>
						{#if !inst.managed}<Badge variant="quiet" size="xs" shape="pill">discovered</Badge>{/if}
					</div>
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
							{#if inst.managed}
								{#if inst.status === "healthy" || inst.status === "starting"}
									<Button touchTarget variant="secondary" size="sm" onclick={() => handleStop(inst.id)}>Stop</Button>
								{:else}
									<Button touchTarget variant="secondary" size="sm" onclick={() => handleStart(inst.id)}>Start</Button>
								{/if}
							{/if}
							<Button touchTarget variant="secondary" size="sm" data-testid="edit-instance-btn" disabled={state.formSaving} aria-expanded={openForm === `instance-edit:${inst.id}`} aria-controls="instance-form" onclick={() => openEditInstance(inst)}>Edit</Button>
							<Button touchTarget variant="danger-outline" size="sm" data-testid="remove-instance-btn" onclick={() => handleRemove(inst.id, inst.name)}>Remove</Button>
						</div>
					</div>
				{/if}
			</div>
		{:else}
			<div class="px-3 py-2 flex flex-col gap-2 text-xs text-text-muted" data-testid="opencode-empty-state">
				<p>No OpenCode servers yet. Start one and it shows up here, or <TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" type="button" tone="accent" data-testid="scan-now-link" disabled={scanInFlight} onclick={handleScanNow}>{scanInFlight ? "Scanning..." : "scan now"}</TextButton>.</p>
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
							{#if ccsDetected}<Icon name="circle-check" size={14} class="text-success ml-auto shrink-0" />{:else if proxyResult === null}<span class="text-xs text-text-muted animate-pulse ml-auto">detecting...</span>{/if}
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
						<Icon name="bot" size={14} class="text-text-muted shrink-0" />
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
								<Button touchTarget variant="danger-outline" size="sm" data-testid="remove-instance-btn" onclick={() => handleRemove(inst.id, inst.name)}>Remove</Button>
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
