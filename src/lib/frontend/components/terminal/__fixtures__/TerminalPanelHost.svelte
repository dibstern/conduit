<script lang="ts">
	import type { GetFileTreeResponse } from "../../../transport/ws-rpc.js";
	import TerminalPanel from "../TerminalPanel.svelte";

	let { folders = [] }: { folders?: GetFileTreeResponse["roots"] } = $props();
</script>

<!-- ChatLayout gives TerminalPanel an explicit 300px-tall parent by default. -->
<div class="h-[300px] w-full">
	<TerminalPanel {folders} />
</div>
