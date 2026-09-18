<script lang="ts">
	import type {
		ClaudeSettingsOverrides,
		JsonValue,
	} from "../../../contracts/claude-settings.js";
	import {
		applyClaudeSettingsResponse,
		applyResolvedClaudeSettingsResponse,
		beginClaudeSettingsResolution,
		claudeSettingsState,
		describeClaudeSettingProvenance,
		failClaudeSettingsResolution,
		getClaudeSettingValue,
		markClaudeSettingsResolutionUnavailable,
		setClaudeSettingEdited,
		proposeClaudeSettingsOverrides,
		type ClaudeSettingKey,
	} from "../../stores/claude-settings.svelte.js";
	import { PERMISSION_MODES } from "../../permission-modes.js";
	import {
		applyDefaultModelSet,
		applyDefaultPermissionMode,
		chooseDefaultModel,
		chooseDefaultPermissionMode,
		discoveryState,
		getAllModels,
		getAvailableInstances,
		getProviderGroups,
	} from "../../stores/discovery.svelte.js";
	import { getCachedInstanceById } from "../../stores/instance.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import {
		getClaudeSettingsRpc,
		reloadProviderSessionRpc,
		resolveClaudeSettingsRpc,
		setClaudeSettingsRpc,
		setDefaultModelRpc,
		setDefaultPermissionModeRpc,
	} from "../../transport/ws-rpc-client.js";
	import { createFrontendLogger } from "../../utils/logger.js";
	import ToggleSetting from "../shared/ToggleSetting.svelte";
	import ClaudeSettingRow from "./ClaudeSettingRow.svelte";

	const log = createFrontendLogger("claude-settings");
	let reloadInFlight = $state(false);

	const autoCompactEnabled = $derived(
		getClaudeSettingValue("autoCompactEnabled"),
	);
	const autoCompactWindow = $derived(
		getClaudeSettingValue("autoCompactWindow"),
	);
	const alwaysThinkingEnabled = $derived(
		getClaudeSettingValue("alwaysThinkingEnabled"),
	);
	const disableAllHooks = $derived(getClaudeSettingValue("disableAllHooks"));
	const cleanupPeriodDays = $derived(
		getClaudeSettingValue("cleanupPeriodDays"),
	);
	const attribution = $derived(getClaudeSettingValue("attribution"));
	const attributionCommit = $derived(
		isAttributionObject(attribution) && typeof attribution.commit === "string"
			? attribution.commit
			: "",
	);
	const attributionPr = $derived(
		isAttributionObject(attribution) && typeof attribution.pr === "string"
			? attribution.pr
			: "",
	);
	const attributionSessionUrl = $derived(
		isAttributionObject(attribution) &&
			typeof attribution.sessionUrl === "boolean"
			? attribution.sessionUrl
			: undefined,
	);
	const autoCompactEnabledProvenance = $derived(
		describeClaudeSettingProvenance(
			"autoCompactEnabled",
			claudeSettingsState.editedKeys.includes("autoCompactEnabled"),
		),
	);
	const autoCompactWindowProvenance = $derived(
		describeClaudeSettingProvenance(
			"autoCompactWindow",
			claudeSettingsState.editedKeys.includes("autoCompactWindow"),
		),
	);
	const alwaysThinkingEnabledProvenance = $derived(
		describeClaudeSettingProvenance(
			"alwaysThinkingEnabled",
			claudeSettingsState.editedKeys.includes("alwaysThinkingEnabled"),
		),
	);
	const disableAllHooksProvenance = $derived(
		describeClaudeSettingProvenance(
			"disableAllHooks",
			claudeSettingsState.editedKeys.includes("disableAllHooks"),
			{ invertBoolean: true },
		),
	);
	const cleanupPeriodDaysProvenance = $derived(
		describeClaudeSettingProvenance(
			"cleanupPeriodDays",
			claudeSettingsState.editedKeys.includes("cleanupPeriodDays"),
		),
	);
	const attributionProvenance = $derived(
		describeClaudeSettingProvenance(
			"attribution",
			claudeSettingsState.editedKeys.includes("attribution"),
		),
	);
	/** Provider and model travel as one <option> value, split on the first
	 *  slash — provider ids have none, model ids often do. */
	const defaultModelValue = $derived(
		discoveryState.defaultModelId
			? `${discoveryState.defaultProviderId}/${discoveryState.defaultModelId}`
			: "",
	);
	/** A default can be persisted for a provider that is not connected right
	 *  now. Carry it as its own option so the select shows what is actually
	 *  stored instead of silently snapping to the first model in the list. */
	const defaultModelMissing = $derived(
		Boolean(discoveryState.defaultModelId) &&
			!getAllModels().some(
				(model) =>
					model.id === discoveryState.defaultModelId &&
					model.provider === discoveryState.defaultProviderId,
			),
	);

	const claudeInstanceId = $derived.by(() => {
		const projectSlug = getCurrentSlug();
		const project = projectState.projects.find(
			(candidate) => candidate.slug === projectSlug,
		);
		const availableInstances = getAvailableInstances();
		if (project?.instanceId) {
			const assigned =
				availableInstances.find(
					(instance) => instance.id === project.instanceId,
				) ?? getCachedInstanceById(project.instanceId);
			if (assigned?.driver === "claude") return assigned.id;
		}
		return availableInstances.find((instance) => instance.driver === "claude")
			?.id;
	});

	$effect(() => {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		let cancelled = false;
		void getClaudeSettingsRpc({ projectSlug })
			.then((response) => {
				if (!cancelled) applyClaudeSettingsResponse(response);
			})
			.catch((error) => log.warn("Claude settings fetch failed:", error));
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		const projectSlug = getCurrentSlug();
		const instanceId = claudeInstanceId;
		if (!projectSlug) return;
		if (!instanceId) {
			markClaudeSettingsResolutionUnavailable(projectSlug);
			return;
		}

		let cancelled = false;
		beginClaudeSettingsResolution(projectSlug);
		void resolveClaudeSettingsRpc({ projectSlug, instanceId })
			.then((response) => {
				if (!cancelled) applyResolvedClaudeSettingsResponse(response);
			})
			.catch((error) => {
				if (!cancelled) failClaudeSettingsResolution(projectSlug);
				log.warn("Claude settings resolution failed:", error);
			});
		return () => {
			cancelled = true;
		};
	});

	/**
	 * Writes the whole overrides object — the relay stores it with replacement
	 * semantics — showing the new value immediately and dropping back to the
	 * relay's if it rejects the write.
	 */
	async function persistOverrides(
		key: ClaudeSettingKey,
		overrides: ClaudeSettingsOverrides,
		edited: boolean,
	): Promise<void> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		const wasEdited = claudeSettingsState.editedKeys.includes(key);
		const undoWrite = proposeClaudeSettingsOverrides(overrides);
		setClaudeSettingEdited(key, edited);
		try {
			await setClaudeSettingsRpc({ projectSlug, overrides });
		} catch {
			undoWrite();
			setClaudeSettingEdited(key, wasEdited);
			showToast("Failed to save Claude settings", { variant: "warn" });
		}
	}

	const setOverride = (key: ClaudeSettingKey, value: boolean | number) =>
		persistOverrides(
			key,
			{ ...claudeSettingsState.overrides, [key]: value },
			true,
		);

	function isAttributionObject(
		value: JsonValue | undefined,
	): value is { readonly [key: string]: JsonValue } {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function getEffectiveAttribution(): { [key: string]: JsonValue } {
		const value = Object.hasOwn(claudeSettingsState.overrides, "attribution")
			? claudeSettingsState.overrides.attribution
			: claudeSettingsState.resolved.attribution?.value;
		return isAttributionObject(value) ? { ...value } : {};
	}

	function setAttributionField(
		field: "commit" | "pr" | "sessionUrl",
		value: string | boolean,
	): Promise<void> {
		return persistOverrides(
			"attribution",
			{
				...claudeSettingsState.overrides,
				attribution: { ...getEffectiveAttribution(), [field]: value },
			},
			true,
		);
	}

	const resetOverride = (key: ClaudeSettingKey) => {
		const { [key]: _removed, ...overrides } = claudeSettingsState.overrides;
		return persistOverrides(key, overrides, false);
	};

	function updateAutoCompactWindow(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement) || input.value === "") return;
		const value = input.valueAsNumber;
		if (Number.isFinite(value)) {
			void setOverride("autoCompactWindow", value);
		}
	}

	function updateCleanupPeriodDays(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement) || input.value === "") return;
		const value = input.valueAsNumber;
		if (Number.isFinite(value)) {
			void setOverride("cleanupPeriodDays", value);
		}
	}

	const DEFAULT_MODE_OPTIONS = PERMISSION_MODES.filter(
		({ sessionOnly }) => !sessionOnly,
	);

	function updateDefaultModel(event: Event): void {
		const select = event.currentTarget;
		if (!(select instanceof HTMLSelectElement)) return;
		const separator = select.value.indexOf("/");
		const projectSlug = getCurrentSlug();
		if (!projectSlug || separator < 0) return;
		const provider = select.value.slice(0, separator);
		const model = select.value.slice(separator + 1);
		const undoDefaultModel = chooseDefaultModel({
			modelId: model,
			providerId: provider,
		});
		void setDefaultModelRpc({ projectSlug, model, provider })
			.then(applyDefaultModelSet)
			.catch(() => {
				undoDefaultModel();
				showToast("Failed to save default model", { variant: "warn" });
			});
	}

	function updateDefaultPermissionMode(event: Event): void {
		const select = event.currentTarget;
		if (!(select instanceof HTMLSelectElement)) return;
		const mode = DEFAULT_MODE_OPTIONS.find(
			(candidate) => candidate.mode === select.value,
		)?.mode;
		const projectSlug = getCurrentSlug();
		if (!mode || !projectSlug) return;
		const undoDefaultMode = chooseDefaultPermissionMode(mode);
		void setDefaultPermissionModeRpc({ projectSlug, mode })
			.then((response) => applyDefaultPermissionMode(response.mode))
			.catch(() => {
				undoDefaultMode();
				showToast("Failed to save default approval mode", { variant: "warn" });
			});
	}

	function updateCommitAttribution(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		void setAttributionField("commit", input.value);
	}

	function updatePrAttribution(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		void setAttributionField("pr", input.value);
	}

	async function reloadSession(): Promise<void> {
		const sessionId = sessionState.currentId;
		const projectSlug = getCurrentSlug();
		if (!sessionId || !projectSlug || reloadInFlight) return;

		reloadInFlight = true;
		try {
			await reloadProviderSessionRpc({
				projectSlug,
				sessionId,
				commandId: crypto.randomUUID(),
			});
			showToast("Session reloaded");
		} catch {
			showToast("Failed to reload the session", { variant: "warn" });
		} finally {
			reloadInFlight = false;
		}
	}
</script>

{#snippet autoCompactEnabledControl(label: string, description: string)}
	<ToggleSetting
		{label}
		{description}
		checked={autoCompactEnabled === true}
		disabled={autoCompactEnabledProvenance.locked}
		dimmed={autoCompactEnabledProvenance.locked}
		onchange={() =>
			void setOverride("autoCompactEnabled", autoCompactEnabled !== true)}
		class="border-none bg-transparent p-0 gap-4 font-brand"
	/>
{/snippet}

{#snippet defaultModelControl(label: string, description: string)}
	<div class="flex flex-col gap-4">
		<div class="flex items-center gap-4">
			<div class="flex-1 min-w-0">
				<label for="claude-default-model" class="text-sm text-text font-medium">
					{label}
				</label>
				<div class="text-xs text-text-muted mt-0.5">{description}</div>
			</div>
			<select
				id="claude-default-model"
				value={defaultModelValue}
				onchange={updateDefaultModel}
				class="shrink-0 max-w-[50%] rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-brand"
				data-testid="claude-setting-defaultModel-select"
			>
				{#if !discoveryState.defaultModelId}
					<option value="" disabled>Not set</option>
				{/if}
				{#if defaultModelMissing}
					<option value={defaultModelValue}>
						{discoveryState.defaultModelId}
					</option>
				{/if}
				{#each getProviderGroups() as group (group.provider.id)}
					<optgroup label={group.provider.name || group.provider.id}>
						{#each group.models as model (model.id)}
							<option value="{group.provider.id}/{model.id}">
								{model.name || model.id}
							</option>
						{/each}
					</optgroup>
				{/each}
			</select>
		</div>
		{#if discoveryState.defaultVariant}
			<p
				class="text-xs text-text-muted"
				data-testid="claude-setting-defaultModel-thinking"
			>
				Thinking level: {discoveryState.defaultVariant}
			</p>
		{/if}
		<p class="text-xs text-text-dimmer">
			The thinking level follows the badge beside the model picker.
		</p>
	</div>
{/snippet}

{#snippet defaultPermissionModeControl(label: string, description: string)}
	<div class="flex flex-col gap-4">
		<div class="flex items-center gap-4">
			<div class="flex-1 min-w-0">
				<label
					for="claude-default-permission-mode"
					class="text-sm text-text font-medium"
				>
					{label}
				</label>
				<div class="text-xs text-text-muted mt-0.5">{description}</div>
			</div>
			<select
				id="claude-default-permission-mode"
				value={discoveryState.defaultPermissionMode}
				onchange={updateDefaultPermissionMode}
				class="rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-brand"
				data-testid="claude-setting-defaultPermissionMode-select"
			>
				{#each DEFAULT_MODE_OPTIONS as { mode, label: modeLabel } (mode)}
					<option value={mode}>{modeLabel}</option>
				{/each}
			</select>
		</div>
		<p class="text-xs text-text-dimmer">
			New sessions start in this mode; the approvals pill still overrides it for the session you're in. Claude Code ignores a default mode set in a project's settings files, so Conduit applies this one itself.
		</p>
		{#if DEFAULT_MODE_OPTIONS.find((m) => m.mode === discoveryState.defaultPermissionMode)?.elevated}
			<p class="text-xs text-warning">
				New sessions will start with elevated permissions.
			</p>
		{/if}
	</div>
{/snippet}

{#snippet autoCompactWindowControl(label: string, description: string)}
	<div class="flex items-center gap-4">
		<div class="flex-1 min-w-0">
			<label
				for="claude-auto-compact-window"
				class="text-sm text-text font-medium"
			>
				{label}
			</label>
			<div class="text-xs text-text-muted mt-0.5">{description}</div>
		</div>
		<input
			id="claude-auto-compact-window"
			type="number"
			value={typeof autoCompactWindow === "number" ? autoCompactWindow : ""}
			disabled={autoCompactEnabled === false ||
				autoCompactWindowProvenance.locked}
			class="w-24 rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-brand disabled:cursor-not-allowed disabled:opacity-40"
			data-testid="claude-setting-autoCompactWindow-input"
			onchange={updateAutoCompactWindow}
		/>
	</div>
{/snippet}

{#snippet alwaysThinkingEnabledControl(label: string, description: string)}
	<ToggleSetting
		{label}
		{description}
		checked={alwaysThinkingEnabled !== false}
		disabled={alwaysThinkingEnabledProvenance.locked}
		dimmed={alwaysThinkingEnabledProvenance.locked}
		onchange={() =>
			void setOverride(
				"alwaysThinkingEnabled",
				alwaysThinkingEnabled === false,
			)}
		class="border-none bg-transparent p-0 gap-4 font-brand"
	/>
{/snippet}

{#snippet disableAllHooksControl(label: string, description: string)}
	<ToggleSetting
		{label}
		{description}
		checked={disableAllHooks !== true}
		disabled={disableAllHooksProvenance.locked}
		dimmed={disableAllHooksProvenance.locked}
		onchange={() =>
			void setOverride("disableAllHooks", disableAllHooks !== true)}
		class="border-none bg-transparent p-0 gap-4 font-brand"
	/>
{/snippet}

{#snippet cleanupPeriodDaysControl(label: string, description: string)}
	<div class="flex items-center gap-4">
		<div class="flex-1 min-w-0">
			<label
				for="claude-cleanup-period-days"
				class="text-sm text-text font-medium"
			>
				{label}
			</label>
			<div class="text-xs text-text-muted mt-0.5">{description}</div>
		</div>
		<div class="flex items-center gap-2">
			<input
				id="claude-cleanup-period-days"
				type="number"
				min="1"
				value={typeof cleanupPeriodDays === "number" ? cleanupPeriodDays : 30}
				disabled={cleanupPeriodDaysProvenance.locked}
				class="w-24 rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-brand disabled:cursor-not-allowed disabled:opacity-40"
				data-testid="claude-setting-cleanupPeriodDays-input"
				onchange={updateCleanupPeriodDays}
			/>
			<span class="text-sm text-text-muted">days</span>
		</div>
	</div>
{/snippet}

{#snippet attributionControl(label: string, description: string)}
	<div class="flex flex-col gap-4">
		<div>
			<div class="text-sm text-text font-medium">{label}</div>
			<div class="text-xs text-text-muted mt-0.5">{description}</div>
		</div>
		<div class="flex flex-col gap-1.5">
			<label for="claude-attribution-commit" class="text-sm text-text font-medium">
				Commit attribution
			</label>
			<input
				id="claude-attribution-commit"
				type="text"
				value={attributionCommit}
				placeholder="Claude Code default"
				disabled={attributionProvenance.locked}
				class="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-brand disabled:cursor-not-allowed disabled:opacity-40"
				data-testid="claude-setting-attribution-commit-input"
				onchange={updateCommitAttribution}
			/>
		</div>
		<div class="flex flex-col gap-1.5">
			<label for="claude-attribution-pr" class="text-sm text-text font-medium">
				Pull request attribution
			</label>
			<input
				id="claude-attribution-pr"
				type="text"
				value={attributionPr}
				placeholder="Claude Code default"
				disabled={attributionProvenance.locked}
				class="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-brand disabled:cursor-not-allowed disabled:opacity-40"
				data-testid="claude-setting-attribution-pr-input"
				onchange={updatePrAttribution}
			/>
		</div>
		<p class="text-xs text-text-dimmer">
			Leave a box empty to add no attribution at all. Reset restores the default.
		</p>
		<ToggleSetting
			label="Session link"
			description="Append the claude.ai session link to commits and pull requests created from web sessions."
			checked={attributionSessionUrl !== false}
			disabled={attributionProvenance.locked}
			dimmed={attributionProvenance.locked}
			onchange={() =>
				void setAttributionField(
					"sessionUrl",
					attributionSessionUrl === false,
				)}
			class="border-none bg-transparent p-0 gap-4 font-brand"
		/>
	</div>
{/snippet}

<div class="space-y-6 font-brand">
	<div>
		<div class="text-xs font-semibold uppercase tracking-widest text-text-muted px-1 mb-2 font-brand">
			Conduit defaults
		</div>
		<div class="space-y-4">
			<p class="px-1 text-xs text-text-dimmer">
				Conduit applies these when it starts a session.
			</p>

			<ClaudeSettingRow
				key="defaultModel"
				label="Default model"
				description="The model Conduit starts a new session with."
				control={defaultModelControl}
			/>

			<ClaudeSettingRow
				key="defaultPermissionMode"
				label="Default approval mode"
				description="How Conduit handles tool approvals in a session you haven't set a mode for."
				control={defaultPermissionModeControl}
			/>

			<p class="px-1 text-xs text-text-dimmer">
				Permission rules aren't editable here. Conduit runs its own approval prompts,
				and a settings rule that auto-allows a tool would silently bypass them.
			</p>
		</div>
	</div>

	<div>
		<div class="text-xs font-semibold uppercase tracking-widest text-text-muted px-1 mb-2 font-brand">
			Claude settings
		</div>
		<div class="space-y-4">
			<p class="px-1 text-xs text-text-dimmer">
				Claude reads these when a session starts. A session that's already running keeps the settings it started with until you reload it.
			</p>

			<ClaudeSettingRow
				key="autoCompactEnabled"
				label="Auto-compact"
				description="Compacts the conversation automatically when the context window fills up."
				provenance={autoCompactEnabledProvenance}
				onreset={() => resetOverride("autoCompactEnabled")}
				control={autoCompactEnabledControl}
			/>

			<ClaudeSettingRow
				key="autoCompactWindow"
				label="Auto-compact threshold"
				description="How much of the context window to leave before compacting."
				provenance={autoCompactWindowProvenance}
				onreset={() => resetOverride("autoCompactWindow")}
				control={autoCompactWindowControl}
			/>

			<ClaudeSettingRow
				key="alwaysThinkingEnabled"
				label="Extended thinking"
				description="Claude thinks before answering on models that support it. Turning this off disables thinking entirely."
				provenance={alwaysThinkingEnabledProvenance}
				onreset={() => resetOverride("alwaysThinkingEnabled")}
				control={alwaysThinkingEnabledControl}
			/>

			<ClaudeSettingRow
				key="disableAllHooks"
				label="Hooks and status line"
				description="Run your configured hooks and status line. Turning this off disables every hook, including any you rely on to block unsafe commands."
				provenance={disableAllHooksProvenance}
				onreset={() => resetOverride("disableAllHooks")}
				control={disableAllHooksControl}
			/>

			<ClaudeSettingRow
				key="cleanupPeriodDays"
				label="Keep transcripts for"
				description="How long Claude keeps chat transcripts on disk before deleting them."
				provenance={cleanupPeriodDaysProvenance}
				onreset={() => resetOverride("cleanupPeriodDays")}
				control={cleanupPeriodDaysControl}
			/>

			<ClaudeSettingRow
				key="attribution"
				label="Attribution"
				description="What Claude adds to commits and pull requests it creates."
				provenance={attributionProvenance}
				onreset={() => resetOverride("attribution")}
				control={attributionControl}
			/>

			<div class="flex items-center gap-4 px-1">
				<p class="flex-1 text-xs text-text-dimmer">
					Restarts Claude on the current settings. Your conversation is kept.
				</p>
				<button
					type="button"
					data-testid="claude-settings-reload-session"
					disabled={!sessionState.currentId || reloadInFlight}
					class="shrink-0 px-3 py-1 text-xs rounded border border-border text-text-muted hover:text-text cursor-pointer bg-transparent disabled:opacity-50 disabled:cursor-not-allowed font-brand"
					onclick={reloadSession}
				>
					Reload this session
				</button>
			</div>
		</div>
	</div>
</div>
