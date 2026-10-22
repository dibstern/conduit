<script lang="ts">
	let { checked, size = "sm", pending = false }: {
		checked: boolean;
		/** xs: 30×18 for footers; sm: 38×22 for settings; lg: 44×26 for switch rows. */
		size?: "xs" | "sm" | "lg";
		pending?: boolean;
	} = $props();
</script>

<!-- Presentational: the host owns the role, checked state, accessible name and interaction. -->
<span aria-hidden="true" data-switch class="relative inline-block shrink-0 rounded-full pointer-events-none transition-colors {size === 'lg' ? 'h-[26px] w-[44px]' : size === 'xs' ? 'h-[18px] w-[30px]' : 'h-[22px] w-[38px]'} {checked ? 'bg-success' : 'bg-text-dimmer/45'} {pending ? 'opacity-45' : ''}">
	<span class="absolute top-[2px] left-[2px] rounded-full bg-white shadow-knob transition-transform {size === 'lg' ? 'size-[22px]' : size === 'xs' ? 'size-[14px]' : 'size-[18px]'} {checked ? (size === 'lg' ? 'translate-x-[18px]' : size === 'xs' ? 'translate-x-[12px]' : 'translate-x-[16px]') : ''}"></span>
</span>
