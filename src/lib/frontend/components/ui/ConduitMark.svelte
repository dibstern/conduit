<script lang="ts">
	let {
		size = "sm",
		"data-testid": testId,
	}: { size?: "sm" | "md"; "data-testid"?: string } = $props();
</script>

<span
	aria-hidden="true"
	data-testid={testId}
	class="grid shrink-0 place-items-center bg-accent text-white {size === 'sm' ? 'size-[20px] rounded-[5px]' : 'size-[26px] rounded-[7px]'}"
>
	<svg viewBox="0 0 12 12" class={size === "sm" ? "size-[12px]" : "size-[15px]"}>
		<path d="M2 4h5a2 2 0 0 1 0 4H5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" />
	</svg>
</span>
