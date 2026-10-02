<script lang="ts">
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import Surface from "../ui/Surface.svelte";
	import {
		composerPreferences,
		setComposerPreferences,
	} from "../../stores/composer-preferences.svelte.js";

	const controls = [
		{ value: "icons", label: "Icons", testId: "settings-composer-controls-icons" },
		{ value: "words", label: "Words", testId: "settings-composer-controls-words" },
	] as const;
	const contextWarnings = [
		{ value: "60", label: "60%", testId: "settings-composer-context-warning-60" },
		{ value: "70", label: "70%", testId: "settings-composer-context-warning-70" },
		{ value: "80", label: "80%", testId: "settings-composer-context-warning-80" },
		{ value: "90", label: "90%", testId: "settings-composer-context-warning-90" },
		{ value: "never", label: "Never", testId: "settings-composer-context-warning-never" },
	] as const;
</script>

<div class="space-y-2">
	<Surface variant="card" padding="lg" radius="panel" class="font-brand">
		<h3 class="text-base font-medium text-text">Controls</h3>
		<SegmentedControl
			bind:value={() => composerPreferences.controls, (controls) => setComposerPreferences({ controls })}
			options={controls}
			label="Controls"
			class="mt-3"
		/>
		<p class="mt-3 text-xs text-text-muted">
			<b class="font-semibold">Icons</b> puts model, effort and approvals in the composer as icon buttons.
			<b class="font-semibold">Words</b> lists them as text under the field.
		</p>
	</Surface>

	<Surface variant="card" padding="lg" radius="panel" class="font-brand">
		<h3 class="text-base font-medium text-text">Context warning</h3>
		<SegmentedControl
			bind:value={() => String(composerPreferences.contextWarning), (value) => setComposerPreferences({ contextWarning: value === "never" ? "never" : Number(value) as 60 | 70 | 80 | 90 })}
			options={contextWarnings}
			label="Context warning"
			class="mt-3"
		/>
		<p class="mt-3 text-xs text-text-muted">
			Show the <b class="font-semibold">Compact</b> bar and turn the context % amber once the session is this full.
			<b class="font-semibold">Never</b> hides both.
		</p>
	</Surface>
</div>
