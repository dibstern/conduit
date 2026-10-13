<script lang="ts">
	import type { UsageReading } from "../../../contracts/limit-recovery.js";
	import { planUsageWindows, usageForecastCopy, usageForecastLevel, usageForecastWindow, usageOtherForecast, usageWindowLimited, type PlanUsageWindow } from "../../utils/continuation.js";
	import SegmentedControl from "../ui/SegmentedControl.svelte";

	let { account, now, framed = false }: { account: UsageReading; now: number; framed?: boolean } = $props();
	let selected = $state<PlanUsageWindow["kind"]>();
	let width = $state(250);
	const windows = $derived(planUsageWindows(account));
	const initial = $derived(usageForecastWindow(account));
	const window = $derived(windows.find((item) => item.kind === selected && (item.forecast || usageWindowLimited(account, item))) ?? initial);
	const copy = $derived(window ? usageForecastCopy(account, window, now) : undefined);
	const other = $derived(usageOtherForecast(windows.find((item) => item.kind !== window?.kind), now));
	const level = $derived(usageForecastLevel(account));
	const prefix = $derived(`usage-settings-forecast-${account.accountId}`);
	const chart = $derived.by(() => {
		if (!window?.resetsAt || width <= 0) return undefined;
		const reset = Date.parse(window.resetsAt);
		if (!Number.isFinite(reset)) return undefined;
		const duration = window.kind === "five_hour" ? 5 * 3_600_000 : 7 * 86_400_000;
		const start = reset - duration;
		const x = (at: number) => Math.max(0, Math.min(width, (at - start) / duration * width));
		const y = (used: number) => 70 - Math.max(0, Math.min(110, used)) / 110 * 62;
		const limited = usageWindowLimited(account, window);
		const points = (window.history ?? [{ at: account.readAt || now, utilization: window.utilization }])
			.filter((point) => point.at >= start && point.at <= Math.min(now, reset));
		if (limited) points.push({ at: Math.min(now, reset), utilization: 100 });
		const latest = points.at(-1) ?? { at: Math.min(now, reset), utilization: window.utilization };
		const crossing = !limited && window.forecast?.kind === "runs_out" ? x(window.forecast.at) : undefined;
		const endX = crossing ?? width;
		const endY = y(limited || crossing !== undefined ? 100 : window.forecast?.kind === "under" ? window.forecast.atReset : latest.utilization);
		return {
			past: points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.at).toFixed(1)} ${y(point.utilization).toFixed(1)}`).join(" "),
			projection: `M${x(latest.at).toFixed(1)} ${y(latest.utilization).toFixed(1)} L${endX.toFixed(1)} ${endY.toFixed(1)}`,
			crossing,
			now: x(now),
			limit: y(100),
		};
	});
</script>

{#if initial && window && copy}
	<div
		id={prefix}
		data-testid={prefix}
		data-level={level}
		data-window={window.kind}
		data-framed={framed}
		class="min-w-0 {framed ? `mb-[12px] rounded-[12px] border px-[12px] py-[10px] ${level === 'red' ? 'border-fill-red/40 bg-fill-red/[0.06]' : level === 'amber' ? 'border-fill-amber/35 bg-fill-amber/[0.05]' : 'border-border bg-bg'}` : 'mt-[9px]'}"
	>
		<div class="mb-[6px] flex items-start gap-[10px]">
			<div class="min-w-0 flex-1 text-[12px] leading-[1.45]">
				{#if framed}<div data-testid="{prefix}-label" class="font-mono text-[10px] tracking-[0.05em] text-text-dimmer uppercase">Forecast</div>{/if}
				<span data-testid="{prefix}-sentence" class="{level === 'red' ? 'text-error' : level === 'amber' ? 'text-fill-amber' : 'text-text-secondary'}">{copy.before}<b>{copy.highlight}</b>{copy.after}</span>
			</div>
			<SegmentedControl
				variant="joined"
				label="Forecast window"
				class="text-[10px]"
				options={(["five_hour", "seven_day"] as const).map((kind) => ({ value: kind, label: kind === "five_hour" ? "5h" : "Week", testId: `${prefix}-${kind}`, disabled: !windows.some((item) => item.kind === kind && (item.forecast || usageWindowLimited(account, item))) }))}
				bind:value={() => window?.kind ?? "five_hour", (next) => { selected = next; }}
			/>
		</div>
		<div class="w-full" bind:clientWidth={width}>
			{#if chart}
				<svg data-testid="{prefix}-chart" data-window={window.kind} width="100%" height="76" viewBox="0 0 {width} 76" role="img" aria-label="{window.kind === 'five_hour' ? '5-hour' : 'Weekly'} usage forecast" class="block {level === 'red' ? 'text-error' : level === 'amber' ? 'text-fill-amber' : 'text-text-secondary'}">
					<line data-testid="{prefix}-limit-line" x1="0" x2={width} y1={chart.limit} y2={chart.limit} stroke="var(--color-fill-red)" stroke-dasharray="2 3" opacity="0.6" />
					<line data-testid="{prefix}-now-marker" x1={chart.now} x2={chart.now} y1="4" y2="76" stroke="var(--color-border)" />
					<g font-size="8" fill="var(--color-text-dimmer)" class="font-mono">
						<text x="2" y={chart.limit - 3}>limit</text>
						<text x={Math.min(width - 24, chart.now + 3)} y="73">now</text>
						<text x={width - 2} y="73" text-anchor="end">reset</text>
					</g>
					<path data-testid="{prefix}-past-path" d={chart.past} stroke="currentColor" stroke-width="2" fill="none" />
					<path data-testid="{prefix}-projection-path" d={chart.projection} stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" fill="none" />
					{#if chart.crossing !== undefined}<circle data-testid="{prefix}-crossing-dot" cx={chart.crossing} cy={chart.limit} r="3.5" fill="currentColor" />{/if}
				</svg>
			{/if}
		</div>
		{#if other}<div data-testid="{prefix}-other" class="mt-[5px] font-mono text-[10.5px] text-text-dimmer">{other}</div>{/if}
	</div>
{/if}
