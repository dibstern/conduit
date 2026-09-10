<script lang="ts">
	import type { ClaudeSettingsOverrides } from "../../../contracts/claude-settings.js";
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
		setClaudeSettingsOverridesOptimistically,
		type ClaudeSettingKey,
		type ClaudeSettingProvenance,
	} from "../../stores/claude-settings.svelte.js";
	import { getAvailableInstances } from "../../stores/discovery.svelte.js";
	import { getCachedInstanceById } from "../../stores/instance.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import {
		getClaudeSettingsRpc,
		resolveClaudeSettingsRpc,
		setClaudeSettingsRpc,
	} from "../../transport/ws-rpc-client.js";
	import { createFrontendLogger } from "../../utils/logger.js";
	import ToggleSetting from "../shared/ToggleSetting.svelte";

	const log = createFrontendLogger("claude-settings");

	const autoCompactEnabled = $derived(
		getClaudeSettingValue("autoCompactEnabled"),
	);
	const autoCompactWindow = $derived(
		getClaudeSettingValue("autoCompactWindow"),
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
	 * semantics — showing the new value immediately and putting the panel back
	 * the way it was if the relay rejects the write.
	 */
	async function persistOverrides(
		key: ClaudeSettingKey,
		overrides: ClaudeSettingsOverrides,
		edited: boolean,
	): Promise<void> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		const previousOverrides = { ...claudeSettingsState.overrides };
		const wasEdited = claudeSettingsState.editedKeys.includes(key);
		setClaudeSettingsOverridesOptimistically(overrides);
		setClaudeSettingEdited(key, edited);
		try {
			await setClaudeSettingsRpc({ projectSlug, overrides });
		} catch {
			setClaudeSettingsOverridesOptimistically(previousOverrides);
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
</script>

{#snippet provenance(
	key: ClaudeSettingKey,
	description: ClaudeSettingProvenance,
)}
	<div
		class="flex items-center justify-between gap-3 text-xs text-text-dimmer"
		data-testid="claude-setting-{key}-provenance"
	>
		<span>
			{description.beforeSource ?? ""}{#if description.sourceLabel}<span title={description.sourcePath}>{description.sourceLabel}</span>{/if}{description.afterSource ?? (description.sourceLabel ? "" : description.text)}
		</span>
		{#if description.canReset}
			<button
				type="button"
				class="shrink-0 border-none bg-transparent text-xs text-text-muted hover:text-text cursor-pointer font-brand"
				data-testid="claude-setting-{key}-reset"
				onclick={() => void resetOverride(key)}
			>
				Reset
			</button>
		{/if}
	</div>
{/snippet}

<div class="space-y-4 font-brand">
	<p class="px-1 text-xs text-text-dimmer">
		Claude reads these when a session starts. Changes apply to new sessions —
		they don't change a session that's already running.
	</p>

	<div
		class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand flex flex-col"
		data-testid="claude-setting-autoCompactEnabled"
	>
		<ToggleSetting
			label="Auto-compact"
			description="Compacts the conversation automatically when the context window fills up."
			checked={autoCompactEnabled === true}
			disabled={autoCompactEnabledProvenance.locked}
			dimmed={autoCompactEnabledProvenance.locked}
			onchange={() =>
				void setOverride("autoCompactEnabled", autoCompactEnabled !== true)}
			class="border-none bg-transparent p-0 gap-4 font-brand"
		/>
		{@render provenance(
			"autoCompactEnabled",
			autoCompactEnabledProvenance,
		)}
	</div>

	<div
		class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand flex flex-col"
		data-testid="claude-setting-autoCompactWindow"
	>
		<div class="flex items-center gap-4">
			<div class="flex-1 min-w-0">
				<label
					for="claude-auto-compact-window"
					class="text-sm text-text font-medium"
				>
					Auto-compact threshold
				</label>
				<div class="text-xs text-text-muted mt-0.5">
					How much of the context window to leave before compacting.
				</div>
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
		{@render provenance("autoCompactWindow", autoCompactWindowProvenance)}
	</div>

	<p class="px-1 text-xs text-text-dimmer">
		Permission rules aren't editable here. Conduit runs its own approval prompts,
		and a settings rule that auto-allows a tool would silently bypass them.
	</p>
</div>
