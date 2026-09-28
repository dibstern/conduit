<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import TextInput from "../ui/TextInput.svelte";
	import { sessionVerbActions } from "./session-verbs.js";

	let { session, onend, class: className = "" }: {
		session: SessionInfo;
		onend: () => void;
		class?: string | undefined;
	} = $props();

	let value = $state("");
	$effect(() => { value = session.title || "New Session"; });
	let ended = false;

	function commit() {
		if (ended) return;
		ended = true;
		const title = value.trim();
		onend();
		if (title && title !== session.title) void sessionVerbActions.rename(session, title);
	}

	function cancel() {
		if (ended) return;
		ended = true;
		onend();
	}
</script>

<TextInput
	aria-label="Session name"
	size="sm"
	class={className}
	bind:value
	onkeydown={(event) => {
		if (event.key === "Enter") { event.preventDefault(); commit(); }
		else if (event.key === "Escape") { event.preventDefault(); cancel(); }
	}}
	onblur={commit}
	onclick={(event) => { event.preventDefault(); event.stopPropagation(); }}
	autofocus
/>
