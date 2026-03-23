<!-- ─── Status Box ────────────────────────────────────────────────────────── -->
<!-- Colored status indicator box used across setup steps.                   -->

<script lang="ts">
	import type { StatusVariant } from "../../utils/setup-utils.js";

	let {
		status,
		message,
	}: {
		status: StatusVariant;
		message: string;
	} = $props();

	const statusClasses = $derived.by(() => {
		if (status === "ok")
			return "bg-success/10 text-success border-success/15";
		if (status === "warn") return "bg-bg-alt text-text border-border";
		return "bg-bg-alt text-text-muted border-border";
	});
</script>

<div
	class="flex items-center gap-2 px-4 py-3 rounded-[10px] text-base my-4 {statusClasses}"
	style="border-width: 1px;"
>
	{message}
</div>
