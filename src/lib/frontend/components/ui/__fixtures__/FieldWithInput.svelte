<script lang="ts">
	import Field from "../Field.svelte";
	import TextInput from "../TextInput.svelte";

	let {
		label = "Email",
		hint,
		error,
		required = false,
	}: {
		label?: string | undefined;
		hint?: string | undefined;
		error?: string | undefined;
		required?: boolean | undefined;
	} = $props();
</script>

<Field {label} {hint} {error} {required}>
	<TextInput type="email" placeholder="you@example.com" />
</Field>
