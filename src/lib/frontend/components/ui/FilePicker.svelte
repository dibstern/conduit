<!--
  A hidden native file input opened with `open()`. Keep it mounted: iOS Safari
  can garbage-collect a detached input while its picker is open, so the pick
  never fires `change` and the chosen files are lost.
-->
<script lang="ts">
	let { accept, multiple = false, capture, onpick }: {
		accept?: string;
		multiple?: boolean;
		capture?: "user" | "environment";
		onpick: (files: File[]) => void;
	} = $props();
	let input: HTMLInputElement | undefined = $state();

	export function open(): void {
		input?.click();
	}
</script>

<input
	bind:this={input} type="file" {accept} {multiple} {capture} hidden
	onchange={(event) => {
		const files = Array.from(event.currentTarget.files ?? []);
		// Clearing lets the same file be picked again.
		event.currentTarget.value = "";
		if (files.length > 0) onpick(files);
	}}
/>
