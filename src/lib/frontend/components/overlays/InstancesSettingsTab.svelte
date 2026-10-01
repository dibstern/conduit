<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import { applyInstanceListResponse, applyScanNowResponse, beginScan, clearScanInFlight, getCachedInstances, getProxyDetection, getScanResult, instanceStatusColor, isScanInFlight } from "../../stores/instance.svelte.js";
	import { confirm, showToast } from "../../stores/ui.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { addInstanceRpc, removeInstanceRpc, renameInstanceRpc, scanNowRpc, startInstanceRpc, stopInstanceRpc, updateInstanceRpc } from "../../transport/ws-rpc-client.js";

	const INSTANCE_KEY_COPY_FEEDBACK_MS = 2_000;

	let { state = $bindable() }: { state: {
		expandedInstanceId: string | null;
		renamingInstanceId: string | null;
		renameValue: string;
		expandedScenario: string | null;
		copiedKey: string | null;
		copyTimer: ReturnType<typeof setTimeout> | null;
		instanceFormMode: "add" | "edit" | null;
		editingInstanceId: string | null;
		formDriver: "claude" | "opencode";
		formName: string;
		formConfigDir: string;
		formManaged: boolean;
		formPort: string;
		formUrl: string;
		formEnv: string;
		formSaving: boolean;
	} } = $props();
	const DRIVER_OPTIONS = ["opencode", "claude"] as const;
	const DRIVER_TAB_OPTIONS = DRIVER_OPTIONS.map((driver) => ({
		value: driver,
		label: driver === "claude" ? "Claude" : "OpenCode",
		testId: `instance-form-driver-${driver}`,
	}));
	const instances = $derived(getCachedInstances());
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);
	function getRpcProjectSlug(): string | null {
		const slug = getCurrentSlug();
		if (!slug) {
			showToast("No active project connection", { variant: "warn" });
			return null;
		}
		return slug;
	}

	function handleToggleInstance(instanceId: string) {
		state.expandedInstanceId = state.expandedInstanceId === instanceId ? null : instanceId;
		if (state.expandedInstanceId !== instanceId) state.renamingInstanceId = null;
	}
	function handleStart(instanceId: string) {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		void startInstanceRpc({ projectSlug, instanceId })
			.then(applyInstanceListResponse)
			.catch(() => showToast("Failed to start instance", { variant: "warn" }));
	}
	function handleStop(instanceId: string) {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		void stopInstanceRpc({ projectSlug, instanceId })
			.then(applyInstanceListResponse)
			.catch(() => showToast("Failed to stop instance", { variant: "warn" }));
	}
	async function handleRemove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(`Remove instance "${instanceName}"? This cannot be undone.`);
		if (confirmed) {
			const projectSlug = getRpcProjectSlug();
			if (!projectSlug) return;
			void removeInstanceRpc({ projectSlug, instanceId })
				.then(applyInstanceListResponse)
				.catch(() =>
					showToast("Failed to remove instance", { variant: "warn" }),
				);
		}
	}
	function instanceDriver(inst: { driver?: string }): "claude" | "opencode" {
		return inst.driver === "claude" ? "claude" : "opencode";
	}
	function closeInstanceForm() {
		state.instanceFormMode = null;
		state.editingInstanceId = null;
		state.formDriver = "opencode";
		state.formName = "";
		state.formConfigDir = "";
		state.formManaged = false;
		state.formPort = "";
		state.formUrl = "";
		state.formEnv = "";
		state.formSaving = false;
	}
	function openAddInstance(driver: "claude" | "opencode" = "opencode") {
		closeInstanceForm();
		state.instanceFormMode = "add";
		state.formDriver = driver;
	}
	function openEditInstance(inst: {
		id: string;
		name: string;
		driver?: string;
		port?: number;
		configDir?: string;
		managed?: boolean;
		env?: Record<string, string>;
	}) {
		state.expandedInstanceId = null;
		state.instanceFormMode = "edit";
		state.editingInstanceId = inst.id;
		state.formDriver = instanceDriver(inst);
		state.formName = inst.name;
		state.formConfigDir = inst.configDir ?? "";
		state.formManaged = inst.managed ?? false;
		state.formPort = inst.port ? String(inst.port) : "";
		state.formUrl = "";
		state.formEnv = inst.env
			? Object.entries(inst.env)
					.map(([k, v]) => `${k}=${v}`)
					.join("\n")
			: "";
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
		const name = state.formName.trim();
		if (!name) {
			showToast("Instance name is required", { variant: "warn" });
			return;
		}
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		const isClaude = state.formDriver === "claude";
		const port = state.formPort.trim() ? Number(state.formPort.trim()) : undefined;
		if (!isClaude && port !== undefined && !Number.isInteger(port)) {
			showToast("Port must be a whole number", { variant: "warn" });
			return;
		}
		const env = isClaude ? undefined : parseEnv(state.formEnv);
		const configDir = state.formConfigDir.trim() || undefined;
		const url = state.formUrl.trim() || undefined;
		state.formSaving = true;
		const request =
			state.instanceFormMode === "edit" && state.editingInstanceId
				? updateInstanceRpc({
						projectSlug,
						instanceId: state.editingInstanceId,
						name,
						...(isClaude
							? { ...(configDir !== undefined ? { configDir } : {}) }
							: {
									...(port !== undefined ? { port } : {}),
									...(env !== undefined ? { env } : {}),
								}),
					})
				: addInstanceRpc({
						projectSlug,
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
		void request
			.then((response) => {
				applyInstanceListResponse(response);
				closeInstanceForm();
			})
			.catch(() => {
				state.formSaving = false;
				showToast(
					`Failed to ${state.instanceFormMode === "edit" ? "update" : "add"} instance`,
					{ variant: "warn" },
				);
			});
	}
	function handleScanNow() {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		beginScan();
		void scanNowRpc({ projectSlug })
			.then(applyScanNowResponse)
			.catch(() => {
				clearScanInFlight();
				showToast("Port scan failed", { variant: "warn" });
			});
	}
	function startRename(instanceId: string, currentName: string) {
		state.renamingInstanceId = instanceId;
		state.renameValue = currentName;
	}
	function submitRename() {
		if (!state.renamingInstanceId) return;
		const trimmed = state.renameValue.trim();
		if (!trimmed) { showToast("Instance name cannot be empty", { variant: "warn" }); return; }
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		void renameInstanceRpc({
			projectSlug,
			instanceId: state.renamingInstanceId,
			name: trimmed,
		})
			.then(applyInstanceListResponse)
			.catch(() => showToast("Failed to rename instance", { variant: "warn" }));
		state.renamingInstanceId = null;
	}
	function cancelRename() { state.renamingInstanceId = null; }
	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") { e.preventDefault(); submitRename(); }
		else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
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
	<div class="group/cmd flex items-start gap-1.5 bg-black/[0.04] dark:bg-white/[0.06] rounded px-2.5 py-1.5 font-mono text-xs text-text leading-relaxed">
		<span class="flex-1 whitespace-pre-wrap break-all select-all">{cmd}</span>
		<TextButton type="button" class="shrink-0 p-0.5 opacity-0 group-hover/cmd:opacity-100 transition-opacity" title="Copy" aria-label="Copy" onclick={() => handleCopy(cmd, key)}>
			{#if state.copiedKey === key}<Icon name="check" size={13} class="text-green-500" />{:else}<Icon name="copy" size={13} />{/if}
		</TextButton>
	</div>
{/snippet}

<div id="instances-settings">
<div class="flex items-center justify-between mb-3">
	<span class="text-xs text-text-muted font-medium uppercase tracking-wide font-brand">
		{instances.length} instance{instances.length !== 1 ? "s" : ""}
	</span>
	<div class="flex items-center gap-2">
	<!-- Icon stays a child rather than `icon=`: Button renders it at
	     16, this is 12, and only a child can carry the spin class. -->
	<Button
		variant="secondary"
		tone="muted"
		hoverFill="none"
		size="content"
		class="gap-1.5 px-2.5 py-1 text-xs rounded hover:border-text-muted font-brand"
		data-testid="scan-now-btn"
		disabled={scanInFlight}
		onclick={handleScanNow}
	>
		<Icon name="refresh-cw" size={12} class={scanInFlight ? "animate-spin" : ""} />
		{scanInFlight ? "Scanning..." : "Scan Now"}
	</Button>
	<Button
		variant="ghost-accent"
		size="content"
		class="gap-1.5 px-2.5 py-1 text-xs rounded border border-accent font-brand"
		data-testid="add-instance-btn"
		onclick={() => openAddInstance()}
	>
		<Icon name="plus" size={12} />
		Add
	</Button>
	</div>
</div>

{#if state.instanceFormMode !== null}
	<div class="mb-3 border border-border rounded-lg p-3 space-y-3 font-brand" data-testid="instance-form">
		<div class="flex items-center justify-between">
			<span class="text-xs text-text-muted font-medium uppercase tracking-wide">
				{state.instanceFormMode === "edit" ? "Edit instance" : "New instance"}
			</span>
		</div>
		{#if state.instanceFormMode === "add"}
			<SegmentedControl
				bind:value={state.formDriver}
				label="Driver"
				options={DRIVER_TAB_OPTIONS}
			/>
		{/if}
		<label class="block space-y-1">
			<span class="text-xs text-text-muted">Name</span>
			<TextInput
				data-testid="instance-form-name"
				placeholder={state.formDriver === "claude" ? "Work Claude" : "Staging OC"}
				bind:value={state.formName}
			/>
		</label>
		{#if state.formDriver === "claude"}
			<label class="block space-y-1">
				<span class="text-xs text-text-muted">Config directory <span class="opacity-60">(optional)</span></span>
				<TextInput
					data-testid="instance-form-configdir"
					placeholder="~/.config/claude/work"
					bind:value={state.formConfigDir}
				/>
			</label>
		{:else}
			<label class="flex items-center gap-2 text-sm text-text cursor-pointer">
				<Checkbox data-testid="instance-form-managed" bind:checked={state.formManaged} />
				<span>Managed <span class="text-xs text-text-muted">(conduit starts the server)</span></span>
			</label>
			{#if state.formManaged}
				<label class="block space-y-1">
					<span class="text-xs text-text-muted">Port</span>
					<TextInput inputmode="numeric" data-testid="instance-form-port" placeholder="4098" bind:value={state.formPort} />
				</label>
			{:else}
				<label class="block space-y-1">
					<span class="text-xs text-text-muted">URL <span class="opacity-60">(or port)</span></span>
					<TextInput data-testid="instance-form-url" placeholder="http://127.0.0.1:4098" bind:value={state.formUrl} />
				</label>
				<label class="block space-y-1">
					<span class="text-xs text-text-muted">Port <span class="opacity-60">(optional)</span></span>
					<TextInput inputmode="numeric" data-testid="instance-form-port" placeholder="4098" bind:value={state.formPort} />
				</label>
			{/if}
			<label class="block space-y-1">
				<span class="text-xs text-text-muted">Environment <span class="opacity-60">(KEY=VALUE per line, optional)</span></span>
				<Textarea data-testid="instance-form-env" rows={2} class="resize-y font-mono" placeholder="ANTHROPIC_API_KEY=sk-ant-..." bind:value={state.formEnv} />
			</label>
		{/if}
		<div class="flex justify-end gap-2 pt-1">
			<Button variant="secondary" tone="muted" hoverFill="none" size="content" class="px-3 py-1 text-xs rounded" data-testid="instance-form-cancel" onclick={closeInstanceForm}>Cancel</Button>
			<Button variant="ghost-accent" size="content" class="px-3 py-1 text-xs rounded border border-accent" data-testid="instance-form-save" disabled={state.formSaving} onclick={submitInstanceForm}>{state.formSaving ? "Saving..." : "Save"}</Button>
		</div>
	</div>
{/if}

{#if scanResult && !scanInFlight}
<div class="mb-3 text-xs text-text-muted bg-white/[0.04] rounded px-2.5 py-1.5 font-brand">
		{#if scanResult.discovered.length > 0}
			Found {scanResult.discovered.length} new instance{scanResult.discovered.length !== 1 ? "s" : ""} on port{scanResult.discovered.length !== 1 ? "s" : ""} {scanResult.discovered.join(", ")}.
		{:else if scanResult.lost.length > 0}
			{scanResult.lost.length} instance{scanResult.lost.length !== 1 ? "s" : ""} lost (port{scanResult.lost.length !== 1 ? "s" : ""} {scanResult.lost.join(", ")}).
		{:else if scanResult.active.length > 0}
			{scanResult.active.length} active instance{scanResult.active.length !== 1 ? "s" : ""} on port{scanResult.active.length !== 1 ? "s" : ""} {scanResult.active.join(", ")} (no changes).
		{:else}
			No active instances found.
		{/if}
	</div>
{/if}

{#if instances.length > 0}
<div id="instance-settings-list" class="space-y-1 font-brand">
		{#each instances as inst}
			{@const driver = instanceDriver(inst)}
			<div class="border border-border rounded-lg" data-testid="instance-row-{inst.id}" data-driver={driver}>
				<Disclosure expanded={state.expandedInstanceId === inst.id} onToggle={() => handleToggleInstance(inst.id)} chevron={false} look="row" density="split" class="justify-between">
					<div class="flex items-center gap-2 min-w-0">
						<span class={"w-2 h-2 rounded-full shrink-0 " + instanceStatusColor(inst.status)}></span>
						{#if state.renamingInstanceId === inst.id}
							<!-- svelte-ignore a11y_autofocus -->
							<!-- The bespoke version hard-coded `border-accent` to say "this
							     one is live". TextInput already says that on focus, and the
							     row is autofocused, so the signal survives the migration --
							     which matters, because an additive `border-accent` here would
							     silently lose to the base `border-border` (Tailwind emits
							     border-colour utilities alphabetically). -->
							<TextInput aria-label="Instance name" size="sm" class="w-36" bind:value={state.renameValue} onkeydown={handleRenameKeydown} onclick={(e) => e.stopPropagation()} onfocusout={submitRename} autofocus />
						{:else}
							<span class="font-medium text-text truncate">{inst.name}</span>
						{/if}
						<Badge variant="tag" shape="pill">{driver === "claude" ? "Claude" : "OpenCode"}</Badge>
						{#if driver === "opencode" && !inst.managed}
							<Badge variant="tag" shape="pill">discovered</Badge>
						{/if}
					</div>
					{#if driver === "claude"}
						<span class="text-text-muted text-xs shrink-0 ml-2 truncate max-w-[10rem]">{inst.configDir || "env"}</span>
					{:else}
						<span class="text-text-muted text-xs shrink-0 ml-2">:{inst.port}</span>
					{/if}
				</Disclosure>
				{#if state.expandedInstanceId === inst.id}
					<div class="flex flex-wrap gap-2 px-3 py-2 border-t border-border">
					{#if driver === "opencode" && inst.managed}
						<Button variant="secondary" size="content" class="px-3 py-1 text-xs rounded" onclick={() => handleStart(inst.id)}>Start</Button>
						<Button variant="secondary" size="content" class="px-3 py-1 text-xs rounded" onclick={() => handleStop(inst.id)}>Stop</Button>
						{/if}
						<Button variant="ghost-accent" size="content" class="px-3 py-1 text-xs rounded border border-border" data-testid="edit-instance-btn" onclick={() => openEditInstance(inst)}>Edit</Button>
						<Button variant="ghost-accent" size="content" class="px-3 py-1 text-xs rounded border border-border" data-testid="rename-instance-btn" onclick={() => startRename(inst.id, inst.name)}>Rename</Button>
					<!-- Three `!` and every one of them is raw Tailwind palette, not a
					     token: border-red-700 / text-red-500 are the headline drift item
				     to normalize across the panel. -->
					<Button variant="danger-outline" size="content" class="px-3 py-1 text-xs rounded" data-testid="remove-instance-btn" onclick={() => handleRemove(inst.id, inst.name)}>Remove</Button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}

{#if instances.length === 0}
<div class="mt-2 space-y-2 font-brand">
		<p class="text-sm text-text-muted mb-3">No OpenCode instances detected. Start one from your terminal and it will appear here automatically.</p>
		<div class="border border-border rounded-lg overflow-hidden">
			<Disclosure expanded={state.expandedScenario === "direct"} onToggle={() => toggleScenario("direct")} chevron={false} look="section" density="roomy">
				<Icon name={state.expandedScenario === "direct" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
				<span>Quick Start — Direct API Key</span>
			</Disclosure>
			{#if state.expandedScenario === "direct"}
				<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
					<p class="text-xs text-text-muted">1. Start an OpenCode server:</p>
					{@render cmdBlock("opencode serve --port 4098", "direct-1")}
					<p class="text-xs text-text-muted">2. Configure your provider:</p>
					{@render cmdBlock("opencode config set provider anthropic\nopencode config set anthropic.apiKey sk-ant-...", "direct-2")}
					<p class="text-xs text-text-muted italic">It will appear here automatically.</p>
				</div>
			{/if}
		</div>
		<div class="border border-border rounded-lg overflow-hidden">
			<Disclosure expanded={state.expandedScenario === "ccs"} onToggle={() => toggleScenario("ccs")} chevron={false} look="section" density="roomy">
				<Icon name={state.expandedScenario === "ccs" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
				<span>Multi-Provider — Via CCS</span>
				{#if ccsDetected}<Icon name="circle-check" size={14} class="text-green-500 ml-auto shrink-0" />{:else if proxyResult === null}<span class="text-xs text-text-muted animate-pulse ml-auto">detecting...</span>{/if}
			</Disclosure>
			{#if state.expandedScenario === "ccs"}
				<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
					<p class="text-xs text-text-muted">CCS manages OAuth tokens and API keys for 20+ providers.</p>
					{#if ccsDetected}
						<div class="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 rounded px-2 py-1"><Icon name="circle-check" size={12} />CCS detected on port {proxyResult?.port ?? 8317}</div>
					{/if}
					<p class="text-xs text-text-muted">1. Install CCS:</p>
					{@render cmdBlock("npm install -g @anthropic-ai/ccs", "ccs-1")}
					<p class="text-xs text-text-muted">2. Authenticate:</p>
					{@render cmdBlock("ccs claude --auth", "ccs-2")}
					<p class="text-xs text-text-muted">3. Start proxy:</p>
					{@render cmdBlock("ccs cliproxy start", "ccs-3")}
					<p class="text-xs text-text-muted">4. Start OpenCode:</p>
					{@render cmdBlock('ANTHROPIC_API_KEY="ccs-internal-managed" \\\n  ANTHROPIC_BASE_URL="http://127.0.0.1:8317/api/provider/claude/v1" \\\n  opencode serve --port 4098', "ccs-4")}
				</div>
			{/if}
		</div>
		<div class="border border-border rounded-lg overflow-hidden">
			<Disclosure expanded={state.expandedScenario === "custom"} onToggle={() => toggleScenario("custom")} chevron={false} look="section" density="roomy">
				<Icon name={state.expandedScenario === "custom" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
				<span>Custom Setup</span>
			</Disclosure>
			{#if state.expandedScenario === "custom"}
				<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
					<p class="text-xs text-text-muted">Configure with environment variables:</p>
					{@render cmdBlock("ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098", "custom-1")}
				</div>
			{/if}
		</div>
		<div class="flex items-center justify-center gap-2 pt-2 text-xs text-text-muted">
			<span>Already started?</span>
			<TextButton type="button" tone="accent" class="font-medium" data-testid="scan-now-link" onclick={handleScanNow}>{scanInFlight ? "Scanning..." : "Scan Now"}</TextButton>
		</div>
	</div>
{/if}
</div>
