<!--
  Empty component for mocking child components in component tests.
  Accepts all props silently to avoid Svelte 5 "unknown prop" warnings
  when parent components pass props to mocked children.
-->
<script lang="ts">
	let { ...rest }: Record<string, unknown> = $props();
</script>

<div data-testid="mock"></div>
