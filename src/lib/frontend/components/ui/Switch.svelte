<script lang="ts">
	let { checked, size = "sm", pending = false }: {
		checked: boolean;
		/** sm: 38×22 for settings rows; lg: 44×26 for the phone sheet's switch row. */
		size?: "sm" | "lg";
		pending?: boolean;
	} = $props();
</script>

<!-- Presentational: the host owns the role, checked state, accessible name and interaction. -->
<span aria-hidden="true" data-switch class="relative inline-block shrink-0 rounded-full pointer-events-none transition-colors {size === 'lg' ? 'h-[26px] w-[44px]' : 'h-[22px] w-[38px]'} {checked ? 'bg-success' : 'bg-text-dimmer/45'} {pending ? 'opacity-45' : ''}">
	<span class="absolute top-[2px] left-[2px] rounded-full bg-white shadow-knob transition-transform {size === 'lg' ? 'size-[22px]' : 'size-[18px]'} {checked ? (size === 'lg' ? 'translate-x-[18px]' : 'translate-x-[16px]') : ''}"></span>
</span>
