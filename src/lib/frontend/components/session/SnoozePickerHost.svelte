<script lang="ts">
	import { snoozePicker } from "../../stores/snooze-picker.svelte.js";
	import { sessionVerbActions } from "./session-verbs.js";
	import SnoozeSheet from "./SnoozeSheet.svelte";
</script>

{#if snoozePicker.session}
	{@const session = snoozePicker.session}
	<SnoozeSheet
		open={true}
		placement={snoozePicker.placement}
		sessionTitle={session.title}
		now={snoozePicker.now}
		onclose={() => { snoozePicker.session = null; }}
		onsnooze={(until) => { void sessionVerbActions.snooze(session, until, snoozePicker.now); }}
	/>
{/if}
