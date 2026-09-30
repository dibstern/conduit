<script lang="ts">
	import Menu from "../../ui/Menu.svelte";
	import SessionVerbItems from "../SessionVerbItems.svelte";
	import type { SessionVerbEntry } from "../session-verbs.js";

	let { presentation = "menu" }: { presentation?: "menu" | "sheet" } = $props();
	const verbs: readonly SessionVerbEntry[] = [
		{ testId: "verb-demo-settle", label: "Settle", icon: "check", run: () => {} },
		{ testId: "verb-demo-auto", label: "Auto-settle when idle", checked: true, run: () => {} },
		{ testId: "verb-demo-snooze", label: "Snooze…", icon: "moon", run: () => {} },
		{ divider: true },
		{ testId: "verb-demo-delete", label: "Delete", danger: true, run: () => {} },
	];
</script>

<Menu open presentation={presentation === "sheet" ? "sheet" : "popover"} ariaLabel="Session verbs">
	{#snippet trigger({ props })}<button {...props} type="button">Session verbs</button>{/snippet}
	<SessionVerbItems {verbs} {presentation} onselect={(run) => run()} />
</Menu>
