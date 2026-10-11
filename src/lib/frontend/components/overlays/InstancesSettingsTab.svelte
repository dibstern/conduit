<script lang="ts">
	import { onDestroy } from "svelte";
	import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
	import type { ServerForm } from "./ServerSettingsTab.svelte";
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
	import { applyDetectProxyResponse, applyInstanceListResponse, applyScanNowResponse, beginProxyDetection, beginScan, clearScanInFlight, getCachedInstances, getProxyDetection, getScanResult, instanceStatusColor, isScanInFlight } from "../../stores/instance.svelte.js";
	import { confirm, showToast } from "../../stores/ui.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { addInstanceRpc, detectProxyRpc, removeInstanceRpc, scanNowRpc, startInstanceRpc, stopInstanceRpc, updateInstanceRpc } from "../../transport/ws-rpc-client.js";

	const INSTANCE_KEY_COPY_FEEDBACK_MS = 2_000;
	const defaultClaudeId = defaultInstanceIdForDriver("claude");
	let { openForm, onToggleForm, onOpenUsage }: { openForm: ServerForm | null; onToggleForm: (form: ServerForm) => void; onOpenUsage: () => void } = $props();
	const instanceFormMode = $derived(openForm === "instance-add" ? "add" : openForm?.startsWith("instance-edit:") ? "edit" : null);
	const editingInstanceId = $derived(instanceFormMode === "edit" ? openForm?.slice("instance-edit:".length) : null);
	const editingDefaultClaude = $derived(editingInstanceId === defaultClaudeId);

	let state = $state({
		expandedInstanceId: null as string | null,
		expandedScenario: null as string | null,
		guidesOpen: false,
		copiedKey: null as string | null,
		copyTimer: null as ReturnType<typeof setTimeout> | null,
		formDriver: "claude" as "claude" | "opencode",
		formName: "",
		formConfigDir: "",
		formManaged: true,
		formPort: "",
		formUrl: "",
		formEnv: "",
		formEnvOpen: false,
		formSaving: false,
	});

	$effect(() => {
		beginProxyDetection();
		void detectProxyRpc()
			.then(applyDetectProxyResponse)
			.catch(() => applyDetectProxyResponse({ found: false, port: 8317 }));
	});
	onDestroy(() => {
		if (state.copyTimer) clearTimeout(state.copyTimer);
	});
	const DRIVER_OPTIONS = ["claude", "opencode"] as const;
	const DRIVER_TAB_OPTIONS = DRIVER_OPTIONS.map((driver) => ({
		value: driver,
		label: driver === "claude" ? "Claude account" : "OpenCode server",
		testId: `instance-form-driver-${driver}`,
	}));
	const instances = $derived(getCachedInstances());
	const claudeAccounts = $derived(instances.filter((inst) => instanceDriver(inst) === "claude"));
	const opencodeInstances = $derived(instances.filter((inst) => instanceDriver(inst) === "opencode"));
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);
	function handleToggleInstance(instanceId: string) {
		state.expandedInstanceId = state.expandedInstanceId === instanceId ? null : instanceId;
	}
	function handleStart(instanceId: string) {
		void startInstanceRpc({ instanceId })
			.then(applyInstanceListResponse)
			.then(refreshServerStatus)
			.catch(() => showToast("Failed to start instance", { variant: "warn" }));
	}
	function handleStop(instanceId: string) {
		void stopInstanceRpc({ instanceId })
			.then(applyInstanceListResponse)
			.then(refreshServerStatus)
			.catch(() => showToast("Failed to stop instance", { variant: "warn" }));
	}
	async function handleRemove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(`Remove instance "${instanceName}"? This cannot be undone.`);
		if (confirmed) {
			void removeInstanceRpc({ instanceId })
				.then(applyInstanceListResponse)
				.then(refreshServerStatus)
				.catch(() =>
					showToast("Failed to remove instance", { variant: "warn" }),
				);
		}
	}
	function instanceDriver(inst: { driver?: string }): "claude" | "opencode" {
		return inst.driver === "claude" ? "claude" : "opencode";
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
		state.formEnvOpen = false;
		state.formSaving = false;
	}
	function openAddInstance(driver: "claude" | "opencode" = "claude") {
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
		state.formDriver = instanceDriver(inst);
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
		const isClaude = state.formDriver === "claude";
		const endpoint = state.formUrl.trim();
		const portText = state.formManaged ? state.formPort.trim() : /^\d+$/.test(endpoint) ? endpoint : "";
		const port = portText ? Number(portText) : undefined;
		if (!isClaude && port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
			showToast("Port must be a whole number between 1 and 65535", { variant: "warn" });
			return;
		}
		if (!isClaude && !state.formManaged && !endpoint) {
			showToast("URL is required", { variant: "warn" });
			return;
		}
		const env = !isClaude && state.formManaged ? parseEnv(state.formEnv) : undefined;
		const configDir = state.formConfigDir.trim() || undefined;
		const url = !state.formManaged && port === undefined ? endpoint || undefined : undefined;
		state.formSaving = true;
		const request =
			instanceFormMode === "edit" && editingInstanceId
				? updateInstanceRpc({
						instanceId: editingInstanceId,
						name,
						...(isClaude
							? { ...(editingDefaultClaude ? { configDir: configDir ?? "" } : configDir !== undefined ? { configDir } : {}) }
							: state.formManaged ? { ...(port !== undefined ? { port } : {}), env: env ?? {} } : {}),
					})
				: addInstanceRpc({
						name,
						driver: state.formDriver,
						...(isClaude
							? {
									managed: false,
									...(configDir !== undefined ? { configDir } : {}),
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
			.catch(() => {
				state.formSaving = false;
				showToast(
					`Failed to ${submittedForm?.startsWith("instance-edit:") ? "update" : "add"} instance`,
					{ variant: "warn" },
				);
			});
	}
	function handleScanNow() {
		beginScan();
		void scanNowRpc()
			.then(applyScanNowResponse)
			.then(refreshServerStatus)
			.catch(() => {
				clearScanInFlight();
				showToast("Port scan failed", { variant: "warn" });
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
		<TextButton type="button" class="shrink-0 p-0.5 opacity-0 group-hover/cmd:opacity-100 transition-opacity" title="Copy" aria-label="Copy" onclick={() => handleCopy(cmd, key)}>
			{#if state.copiedKey === key}<Icon name="check" size={13} class="text-success" />{:else}<Icon name="copy" size={13} />{/if}
		</TextButton>
	</div>
{/snippet}


<div id="instances-settings" class="flex flex-col gap-[7px]">
<div class="flex items-center justify-between gap-[10px]">
	<h3 class="text-[12px] font-semibold text-text">Instances</h3>
	<div class="flex items-center gap-2">
	<Button
		variant="secondary"
		tone="muted"
		hoverFill="none"
		size="content"
		class="gap-1.5 px-2.5 py-1 text-xs rounded-[7px] hover:border-text-muted"
		data-testid="scan-now-btn"
		disabled={scanInFlight}
		onclick={handleScanNow}
	>
		<Icon name="refresh-cw" size={12} class={scanInFlight ? "animate-spin" : ""} />
		{scanInFlight ? "Scanning..." : "Scan"}
	</Button>
	<Button
		variant="ghost-accent"
		size="content"
		class="gap-1.5 px-2.5 py-1 text-xs rounded-[7px] border border-accent"
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
	<form id="instance-form" class="border border-border-subtle bg-bg-surface rounded-[9px] p-3 flex flex-col gap-3" data-server-form data-testid="instance-form" aria-label={instanceFormMode === "edit" ? "Edit instance" : "New instance"} novalidate onsubmit={(event) => { event.preventDefault(); submitInstanceForm(); }}>
		<h4 class="text-[12.5px] font-semibold text-text">{instanceFormMode === "edit" ? `Edit ${instances.find((inst) => inst.id === editingInstanceId)?.name ?? "instance"}` : "New instance"}</h4>
		{#if instanceFormMode === "add"}
			<SettingsRow label="Type" class="p-0">
				{#snippet control()}
					<SegmentedControl bind:value={state.formDriver} label="Type" options={DRIVER_TAB_OPTIONS} />
				{/snippet}
			</SettingsRow>
		{/if}
		{#if state.formDriver === "opencode"}
			<SettingsRow label="Conduit starts it" description="Off: connect to one you run" checked={state.formManaged} onchange={() => { state.formManaged = !state.formManaged; }} disabled={state.formSaving || instanceFormMode === "edit"} testId="instance-form-managed" class="p-0" />
		{/if}
		<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
			<label for="instance-form-name" class="flex flex-col gap-1 text-[11px] text-text-muted">
				Name
				<TextInput id="instance-form-name" data-testid="instance-form-name" placeholder={state.formDriver === "claude" ? "Work Claude" : "Staging OC"} bind:value={state.formName} disabled={state.formSaving} required />
			</label>
			{#if state.formDriver === "claude"}
				<label for="instance-form-configdir" class="flex flex-col gap-1 text-[11px] text-text-muted">
					Config directory (optional)
					<TextInput id="instance-form-configdir" data-testid="instance-form-configdir" placeholder="~/.config/claude/work" bind:value={state.formConfigDir} disabled={state.formSaving} />
				</label>
			{:else if state.formManaged}
				<label for="instance-form-port" class="flex flex-col gap-1 text-[11px] text-text-muted">
					Port
					<TextInput id="instance-form-port" inputmode="numeric" data-testid="instance-form-port" placeholder="4098" bind:value={state.formPort} disabled={state.formSaving} />
				</label>
			{:else}
				<label for="instance-form-url" class="flex flex-col gap-1 text-[11px] text-text-muted">
					URL (or port)
					<TextInput id="instance-form-url" data-testid="instance-form-url" placeholder="http://127.0.0.1:4098" bind:value={state.formUrl} readonly={instanceFormMode === "edit"} disabled={state.formSaving} />
				</label>
			{/if}
		</div>
		{#if state.formDriver === "claude"}
			<p class="text-[11px] text-text-muted">{editingDefaultClaude ? "Folder changes apply after restart. " : ""}Leave the folder empty to use the environment's default Claude login.</p>
		{:else if state.formManaged}
			<SettingsGroup title="Environment variables" summary="KEY=VALUE per line" collapsible bind:open={state.formEnvOpen}>
				<label for="instance-form-env" class="block p-3">
					<span class="sr-only">Environment variables</span>
					<Textarea id="instance-form-env" data-testid="instance-form-env" rows={2} class="resize-y font-mono" placeholder="ANTHROPIC_API_KEY=sk-ant-..." bind:value={state.formEnv} disabled={state.formSaving} />
				</label>
			</SettingsGroup>
		{/if}
		<div class="flex justify-end gap-1.5">
			<Button variant="secondary" size="sm" data-testid="instance-form-cancel" disabled={state.formSaving} onclick={closeInstanceForm}>Cancel</Button>
			<Button variant="primary" size="sm" type="submit" data-testid="instance-form-save" disabled={state.formSaving}>{state.formSaving ? "Saving..." : instanceFormMode === "edit" ? "Save" : "Add instance"}</Button>
		</div>
	</form>
{/if}

<div id="instance-settings-list" class="flex flex-col gap-[6px]">
	{#if claudeAccounts.length > 0}
		<div class="border border-border-subtle rounded-[7px] overflow-hidden" data-testid="claude-accounts-list">
			<div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 bg-bg-alt px-3 py-2">
				<h4 class="text-[12px] font-semibold text-text">Claude accounts</h4>
				<span class="ml-auto flex flex-wrap items-center justify-end gap-1 text-xs text-text-muted">
					<span>Usage and switch order: </span>
					<Button variant="ghost-accent" hoverFill="none" size="content" class="text-xs hover:underline" data-testid="claude-accounts-usage-link" onclick={onOpenUsage}>Usage ›</Button>
				</span>
			</div>
			{#each claudeAccounts as inst (inst.id)}
				<div class="border-t border-border-subtle" data-testid="instance-row-{inst.id}" data-driver="claude">
					<Disclosure expanded={state.expandedInstanceId === inst.id} onToggle={() => handleToggleInstance(inst.id)} look="row" class="min-h-[44px] focus-visible:-outline-offset-2">
						<AccountDot instanceId={inst.id} size={7} />
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="font-medium text-text truncate">{inst.name}</span>
								{#if inst.id === defaultClaudeId}<Badge variant="tag" shape="pill" class="shrink-0">default</Badge>{/if}
							</div>
							<div class="font-mono text-xs text-text-secondary truncate">{inst.configDir || "env"}</div>
						</div>
					</Disclosure>
					{#if state.expandedInstanceId === inst.id}
						<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-alt px-3 py-2">
							<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
								<dt class="text-text-muted">Config dir</dt>
								<dd class="font-mono text-text break-all">{inst.configDir || "env"}</dd>
								<dt class="text-text-muted">Used by</dt>
								<dd class="text-text">{inst.id === defaultClaudeId ? "New sessions, unless a project picks another account" : "Sessions you move to it, and auto-switch"}</dd>
								{#if inst.id === defaultClaudeId}
									<dt class="text-text-muted">Change</dt>
									<dd class="text-text">Applies after restart</dd>
								{/if}
							</dl>
							<div class="flex flex-wrap items-center gap-2">
								<Button variant="ghost-accent" size="content" class="px-3 py-1 text-xs rounded border border-border" data-testid="edit-instance-btn" disabled={state.formSaving} aria-expanded={openForm === `instance-edit:${inst.id}`} aria-controls="instance-form" onclick={() => openEditInstance(inst)}>Edit</Button>
								{#if inst.id === defaultClaudeId}
									<span class="text-xs text-text-muted">The default account can't be removed</span>
								{:else}
									<Button variant="danger-outline" size="content" class="px-3 py-1 text-xs rounded" data-testid="remove-instance-btn" onclick={() => handleRemove(inst.id, inst.name)}>Remove</Button>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
	<SettingsGroup testId="opencode-servers-list">
		<div class="flex items-center gap-2 bg-bg-alt px-3 py-2">
			<h4 class="text-[12px] font-semibold text-text">OpenCode servers</h4>
			{#if opencodeInstances.length > 0}<span class="text-xs text-text-muted">{opencodeInstances.length}</span>{/if}
		</div>
		{#each opencodeInstances as inst (inst.id)}
			<div data-testid="instance-row-{inst.id}" data-driver="opencode">
				<Disclosure expanded={state.expandedInstanceId === inst.id} onToggle={() => handleToggleInstance(inst.id)} look="row" class="min-h-[44px] focus-visible:-outline-offset-2">
					<span class={"w-2 h-2 rounded-full shrink-0 " + instanceStatusColor(inst.status)}></span>
					<div class="flex-1 min-w-0 flex items-center gap-2">
						<span class="font-medium text-text truncate">{inst.name}</span>
						{#if !inst.managed}<Badge variant="tag" shape="pill" class="shrink-0">discovered</Badge>{/if}
					</div>
					<span class="font-mono text-xs text-text-secondary shrink-0">:{inst.port}</span>
				</Disclosure>
				{#if state.expandedInstanceId === inst.id}
					<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-alt px-3 py-2">
						<dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
							<dt class="text-text-muted">Status</dt>
							<dd class="text-text capitalize">{inst.status}</dd>
							<dt class="text-text-muted">Address</dt>
							<dd class="font-mono text-text break-all">{inst.url ?? `http://127.0.0.1:${inst.port}`}</dd>
							<dt class="text-text-muted">Started by</dt>
							<dd class="text-text">{inst.managed ? "Conduit" : "You (found by scan)"}</dd>
						</dl>
						<div class="flex flex-wrap items-center gap-2">
							{#if inst.managed}
								{#if inst.status === "healthy" || inst.status === "starting"}
									<Button variant="secondary" size="sm" onclick={() => handleStop(inst.id)}>Stop</Button>
								{:else}
									<Button variant="secondary" size="sm" onclick={() => handleStart(inst.id)}>Start</Button>
								{/if}
							{/if}
							<Button variant="secondary" size="sm" data-testid="edit-instance-btn" disabled={state.formSaving} aria-expanded={openForm === `instance-edit:${inst.id}`} aria-controls="instance-form" onclick={() => openEditInstance(inst)}>Edit</Button>
							<Button variant="danger-outline" size="sm" data-testid="remove-instance-btn" onclick={() => handleRemove(inst.id, inst.name)}>Remove</Button>
						</div>
					</div>
				{/if}
			</div>
		{:else}
			<div class="px-3 py-2 flex flex-col gap-2 text-xs text-text-muted" data-testid="opencode-empty-state">
				<p>No OpenCode servers yet. Start one and it shows up here, or <TextButton type="button" tone="accent" data-testid="scan-now-link" disabled={scanInFlight} onclick={handleScanNow}>{scanInFlight ? "Scanning..." : "scan now"}</TextButton>.</p>
					{@render cmdBlock("opencode serve --port 4098", "empty-serve")}
				<SettingsGroup title="Setup guides" collapsible bind:open={state.guidesOpen} summary={`Direct key · CCS${ccsDetected ? " ✓" : ""} · Custom${proxyResult === null ? " · detecting..." : ""}`} testId="opencode-setup-guides">
					<div>
						<Disclosure expanded={state.expandedScenario === "direct"} onToggle={() => toggleScenario("direct")} chevron={false} look="section" density="list">
							<Icon name={state.expandedScenario === "direct" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
							<span>Direct key</span>
						</Disclosure>
						{#if state.expandedScenario === "direct"}
							<div class="p-[8px] flex flex-col gap-[6px] border-t border-border-subtle">
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
							<div class="p-[8px] flex flex-col gap-[6px] border-t border-border-subtle">
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
							<div class="p-[8px] flex flex-col gap-[6px] border-t border-border-subtle">
								<p>Configure with environment variables:</p>
								{@render cmdBlock("ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098", "custom-1")}
							</div>
						{/if}
					</div>
				</SettingsGroup>
			</div>
		{/each}
	</SettingsGroup>
</div>

{#if scanResult && !scanInFlight}
	<p class="text-[11px] text-text-muted" data-testid="instance-scan-note" role="status">
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
