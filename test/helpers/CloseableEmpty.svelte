<script lang="ts">
	let { ...rest }: Record<string, unknown> = $props();

	export function close(): void {}
</script>

<div data-testid="mock"></div>
