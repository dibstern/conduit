<script lang="ts">
	import SheetFooter from "../ui/SheetFooter.svelte";
	import type { SessionCommand } from "./session-commands.js";

	let { extras, onselect }: {
		extras: readonly Omit<SessionCommand, "section">[];
		onselect: (run: SessionCommand["run"]) => void;
	} = $props();
</script>

<SheetFooter actions={extras.map((item) => ({
	label: item.shortLabel ?? item.label,
	ariaLabel: item.label,
	testId: item.testId,
	icon: item.icon,
	...(item.checked === undefined ? {} : { checked: item.checked }),
	...(item.tag ? { tag: item.tag } : {}),
	onselect: () => item.checked === undefined ? onselect(item.run) : item.run(),
}))} />
