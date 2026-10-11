<script module lang="ts">
	export type ServerForm = "shutdown" | "instance-add" | `instance-edit:${string}` | "pin-set" | "pin-change" | "pin-remove" | "keep-awake-command";
</script>

<script lang="ts">
	import { onMount, tick } from "svelte";
	import { loadServerStatus } from "../../stores/server-status.svelte.js";
	import ServerStatusSettings from "./ServerStatusSettings.svelte";
	import InstancesSettingsTab from "./InstancesSettingsTab.svelte";
	import ServerSecuritySettings from "./ServerSecuritySettings.svelte";
	import ServerPowerSettings from "./ServerPowerSettings.svelte";
	import ServerAccessSettings from "./ServerAccessSettings.svelte";
	import ServerLogsSettings from "./ServerLogsSettings.svelte";
	import ServerStartupSettings from "./ServerStartupSettings.svelte";

	let { onClose, onOpenUsage }: { onClose?: (() => void) | undefined; onOpenUsage: () => void } = $props();
	let openForm = $state<ServerForm | null>(null);
	let sectionEl = $state<HTMLDivElement>();

	onMount(() => { void loadServerStatus(); });

	async function toggleForm(form: ServerForm): Promise<void> {
		openForm = openForm === form ? null : form;
		if (openForm === null) return;
		await tick();
		if (openForm !== form) return;
		const editor = sectionEl?.querySelector<HTMLElement>("[data-server-form]");
		const field = editor?.matches("input, textarea, select") ? editor : editor?.querySelector<HTMLElement>("input, textarea, select") ?? editor?.querySelector<HTMLElement>("button");
		field?.focus();
		editor?.scrollIntoView({ block: "nearest" });
	}
</script>

<div bind:this={sectionEl} class="flex flex-col gap-[7px]" data-testid="server-settings">
	<ServerStatusSettings {openForm} onToggleForm={toggleForm} {onClose} />
	<InstancesSettingsTab {openForm} onToggleForm={toggleForm} {onOpenUsage} />
	<ServerSecuritySettings {openForm} onToggleForm={toggleForm} />
	<ServerPowerSettings {openForm} onToggleForm={toggleForm} />
	<ServerAccessSettings />
	<ServerLogsSettings />
	<ServerStartupSettings />
</div>
