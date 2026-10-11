<script lang="ts">
	import { onMount } from "svelte";
	import type {
		ClaudeSettingsOverrides,
		JsonValue,
	} from "../../../contracts/claude-settings.js";
	import {
		applyClaudeSettingsResponse,
		applyResolvedClaudeSettingsResponse,
		beginClaudeSettingsResolution,
		claudeSettingsState,
		clearClaudeSettingEdits,
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
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession, reloadProviderSession, sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import {
		getClaudeSettingsRpc,
		resolveClaudeSettingsRpc,
		setClaudeSettingsRpc,
		setDefaultModelRpc,
		setDefaultPermissionModeRpc,
	} from "../../transport/ws-rpc-client.js";
	import { createFrontendLogger } from "../../utils/logger.js";
	import Button from "../ui/Button.svelte";
	import Select from "../ui/Select.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import ClaudeSettingRow from "./ClaudeSettingRow.svelte";

	const log = createFrontendLogger("claude-settings");
	onMount(() => {
		clearClaudeSettingEdits();
		return clearClaudeSettingEdits;
	});
	let reloadInFlight = $state(false);
	const sessionId = $derived(getCurrentSessionId());
	const workspace = $derived(JSON.stringify(sessionId ? findSession(sessionId)?.workspace ?? null : null));

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
		isAttributionObject(attribution) && typeof attribution["commit"] === "string"
			? attribution["commit"]
			: "",
	);
	const attributionPr = $derived(
		isAttributionObject(attribution) && typeof attribution["pr"] === "string"
			? attribution["pr"]
			: "",
	);
	const attributionSessionUrl = $derived(
		isAttributionObject(attribution) &&
			typeof attribution["sessionUrl"] === "boolean"
			? attribution["sessionUrl"]
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
		const requestedWorkspace = workspace;
		if (!projectSlug) return;
		if (!instanceId) {
			markClaudeSettingsResolutionUnavailable(projectSlug);
			return;
		}

		let cancelled = false;
		beginClaudeSettingsResolution(projectSlug);
		void resolveClaudeSettingsRpc({ projectSlug, instanceId, ...(sessionId ? { sessionId } : {}) })
			.then((response) => {
				if (!cancelled && workspace === requestedWorkspace) applyResolvedClaudeSettingsResponse(response);
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
			? claudeSettingsState.overrides["attribution"]
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
			await reloadProviderSession(projectSlug, sessionId);
			showToast("Session reloaded");
		} catch {
			showToast("Failed to reload the session", { variant: "warn" });
		} finally {
			reloadInFlight = false;
		}
	}
</script>

{#snippet defaultModelControl()}
	<Select
		id="claude-default-model"
		value={defaultModelValue}
		onchange={updateDefaultModel}
		class="w-[220px] max-w-full"
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
	</Select>
{/snippet}

{#snippet defaultModelNotes()}
	{#if discoveryState.defaultVariant}
		<p data-testid="claude-setting-defaultModel-thinking">
			Thinking level: {discoveryState.defaultVariant}
		</p>
	{/if}
	<p class="text-text-dimmer">
		The thinking level follows the badge beside the model picker.
	</p>
{/snippet}

{#snippet defaultPermissionModeControl()}
	<Select
		id="claude-default-permission-mode"
		value={discoveryState.defaultPermissionMode}
		onchange={updateDefaultPermissionMode}
		class="w-[220px] max-w-full"
		data-testid="claude-setting-defaultPermissionMode-select"
	>
		{#each DEFAULT_MODE_OPTIONS as { mode, label: modeLabel } (mode)}
			<option value={mode}>{modeLabel}</option>
		{/each}
	</Select>
{/snippet}

{#snippet defaultPermissionModeNotes()}
	<p class="text-text-dimmer">
		New sessions start in this mode; the approvals pill still overrides it for the session you're in. Claude Code ignores a default mode set in a project's settings files, so Conduit applies this one itself.
	</p>
	{#if DEFAULT_MODE_OPTIONS.find((m) => m.mode === discoveryState.defaultPermissionMode)?.elevated}
		<p class="text-warning">
			New sessions will start with elevated permissions.
		</p>
	{/if}
{/snippet}

{#snippet autoCompactWindowControl()}
	<TextInput
		id="claude-auto-compact-window"
		type="number"
		value={typeof autoCompactWindow === "number" ? autoCompactWindow : ""}
		disabled={autoCompactEnabled === false ||
			autoCompactWindowProvenance.locked}
		class="w-[120px]"
		data-testid="claude-setting-autoCompactWindow-input"
		onchange={updateAutoCompactWindow}
	/>
{/snippet}

{#snippet cleanupPeriodDaysControl()}
	<TextInput
		id="claude-cleanup-period-days"
		type="number"
		min="1"
		value={typeof cleanupPeriodDays === "number" ? cleanupPeriodDays : 30}
		disabled={cleanupPeriodDaysProvenance.locked}
		class="w-[120px]"
		data-testid="claude-setting-cleanupPeriodDays-input"
		onchange={updateCleanupPeriodDays}
	/>
	<span>days</span>
{/snippet}

{#snippet attributionEditor()}
	<p class="text-text-dimmer">What Claude adds to commits and pull requests it creates.</p>
	<div class="flex flex-col gap-[4px]">
		<label for="claude-attribution-commit" class="text-text">Commit attribution</label>
		<TextInput
			id="claude-attribution-commit"
			value={attributionCommit}
			placeholder="Claude Code default"
			disabled={attributionProvenance.locked}
			class="w-full"
			data-testid="claude-setting-attribution-commit-input"
			onchange={updateCommitAttribution}
		/>
	</div>
	<div class="flex flex-col gap-[4px]">
		<label for="claude-attribution-pr" class="text-text">Pull request attribution</label>
		<TextInput
			id="claude-attribution-pr"
			value={attributionPr}
			placeholder="Claude Code default"
			disabled={attributionProvenance.locked}
			class="w-full"
			data-testid="claude-setting-attribution-pr-input"
			onchange={updatePrAttribution}
		/>
	</div>
	<p class="text-text-dimmer">
		Leave a box empty to add no attribution at all. Reset restores the default.
	</p>
	<SettingsRow
		label="Session link"
		description="Append the claude.ai session link to commits and pull requests created from web sessions."
		checked={attributionSessionUrl !== false}
		disabled={attributionProvenance.locked}
		onchange={() =>
			void setAttributionField(
				"sessionUrl",
				attributionSessionUrl === false,
			)}
		class="p-0"
	/>
{/snippet}

<SettingsGroup
	title="Conduit defaults"
	caption="Conduit applies these when it starts a session."
>
	<ClaudeSettingRow
		key="defaultModel"
		label="Default model"
		description="The model Conduit starts a new session with."
		labelFor="claude-default-model"
		control={defaultModelControl}
		below={defaultModelNotes}
	/>
	<ClaudeSettingRow
		key="defaultPermissionMode"
		label="Default approval mode"
		description="How Conduit handles tool approvals in a session you haven't set a mode for."
		labelFor="claude-default-permission-mode"
		control={defaultPermissionModeControl}
		below={defaultPermissionModeNotes}
	/>
</SettingsGroup>

<p class="text-text-dimmer">
	Permission rules aren't editable here. Conduit runs its own approval prompts,
	and a settings rule that auto-allows a tool would silently bypass them.
</p>

<SettingsGroup
	title="Claude settings"
	caption="Claude reads these when a session starts. A session that's already running keeps the settings it started with until you reload it."
>
	<ClaudeSettingRow
		key="autoCompactEnabled"
		label="Auto-compact"
		description="Compacts the conversation automatically when the context window fills up."
		provenance={autoCompactEnabledProvenance}
		onreset={() => resetOverride("autoCompactEnabled")}
		checked={autoCompactEnabled === true}
		disabled={autoCompactEnabledProvenance.locked}
		onchange={() =>
			void setOverride("autoCompactEnabled", autoCompactEnabled !== true)}
	/>
	<ClaudeSettingRow
		key="autoCompactWindow"
		label="Auto-compact threshold"
		description="How much of the context window to leave before compacting."
		provenance={autoCompactWindowProvenance}
		onreset={() => resetOverride("autoCompactWindow")}
		labelFor="claude-auto-compact-window"
		control={autoCompactWindowControl}
	/>
	<ClaudeSettingRow
		key="alwaysThinkingEnabled"
		label="Extended thinking"
		description="Claude thinks before answering on models that support it. Turning this off disables thinking entirely."
		provenance={alwaysThinkingEnabledProvenance}
		onreset={() => resetOverride("alwaysThinkingEnabled")}
		checked={alwaysThinkingEnabled !== false}
		disabled={alwaysThinkingEnabledProvenance.locked}
		onchange={() =>
			void setOverride(
				"alwaysThinkingEnabled",
				alwaysThinkingEnabled === false,
			)}
	/>
	<ClaudeSettingRow
		key="disableAllHooks"
		label="Hooks and status line"
		description="Run your configured hooks and status line. Turning this off disables every hook, including any you rely on to block unsafe commands."
		provenance={disableAllHooksProvenance}
		onreset={() => resetOverride("disableAllHooks")}
		checked={disableAllHooks !== true}
		disabled={disableAllHooksProvenance.locked}
		onchange={() =>
			void setOverride("disableAllHooks", disableAllHooks !== true)}
	/>
	<ClaudeSettingRow
		key="cleanupPeriodDays"
		label="Keep transcripts for"
		description="How long Claude keeps chat transcripts on disk before deleting them."
		provenance={cleanupPeriodDaysProvenance}
		onreset={() => resetOverride("cleanupPeriodDays")}
		labelFor="claude-cleanup-period-days"
		control={cleanupPeriodDaysControl}
	/>
</SettingsGroup>

<SettingsGroup
	id="claude-attribution"
	title="Attribution"
	collapsible
	summary="Commit · PR · Session link"
	testId="claude-attribution-group"
>
	<ClaudeSettingRow
		key="attribution"
		provenance={attributionProvenance}
		onreset={() => resetOverride("attribution")}
		below={attributionEditor}
	/>
</SettingsGroup>

<div class="flex items-center gap-[10px] py-[8px]">
	<p class="flex-1 text-text-dimmer">
		Restarts Claude on the current settings. Your conversation is kept.
	</p>
	<Button
		size="sm"
		data-testid="claude-settings-reload-session"
		disabled={!sessionState.currentId || reloadInFlight}
		onclick={reloadSession}
	>
		Reload this session
	</Button>
</div>
