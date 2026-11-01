import type {
	UsageForecast,
	UsageHistoryPoint,
	UsageWindow,
} from "../../../contracts/limit-recovery.js";

export type ForecastSeries = {
	readonly resetsAt?: number | undefined;
	readonly points: readonly UsageHistoryPoint[];
};

export function forecastUsage(
	points: readonly UsageHistoryPoint[],
	latest: number,
	resetsAt: number | undefined,
	now: number,
): UsageForecast | undefined {
	const first = points[0];
	const last = points.at(-1);
	if (
		resetsAt === undefined ||
		!Number.isFinite(resetsAt) ||
		resetsAt <= now ||
		points.length < 3 ||
		!first ||
		!last ||
		last.at - first.at < 15 * 60_000 ||
		latest >= 100
	)
		return undefined;
	// Center time offsets to avoid cancellation with epoch-sized timestamps.
	const meanAt =
		points.reduce((sum, point) => sum + (point.at - first.at), 0) /
		points.length;
	const meanUtilization =
		points.reduce((sum, point) => sum + point.utilization, 0) / points.length;
	let covariance = 0;
	let variance = 0;
	for (const point of points) {
		const offset = point.at - first.at - meanAt;
		covariance += offset * (point.utilization - meanUtilization);
		variance += offset * offset;
	}
	const slope = covariance / variance;
	if (slope <= 0) return { kind: "under", atReset: Math.round(latest) };
	const projected = latest + slope * (resetsAt - last.at);
	return projected >= 100
		? { kind: "runs_out", at: last.at + (100 - latest) / slope }
		: { kind: "under", atReset: Math.round(projected) };
}

const resetTime = (window: UsageWindow) => {
	const parsed = Date.parse(window.resetsAt ?? "");
	return Number.isFinite(parsed) ? parsed : undefined;
};

// Claude recomputes resets_at per request, so only a move of more than a few
// minutes is a new window.
const startsNewWindow = (
	series: ForecastSeries,
	utilization: number,
	resetsAt: number | undefined,
) => {
	const last = series.points.at(-1);
	return (
		(resetsAt !== undefined &&
			series.resetsAt !== undefined &&
			resetsAt - series.resetsAt > 10 * 60_000) ||
		(last !== undefined && utilization < last.utilization)
	);
};

const track = (
	series: ForecastSeries = { points: [] },
	utilization: number,
	resetsAt: number | undefined,
	at: number,
): ForecastSeries => {
	const points = [
		...(startsNewWindow(series, utilization, resetsAt) ? [] : series.points),
		{ at, utilization },
	].slice(-2016);
	const seriesReset = resetsAt ?? series.resetsAt;
	return seriesReset === undefined
		? { points }
		: { points, resetsAt: seriesReset };
};

// Evenly spaced transport samples, including both ends.
const thin = (points: readonly UsageHistoryPoint[]) =>
	points.length <= 48
		? points
		: Array.from({ length: 48 }, (_, i) => i).flatMap(
				(i) => points[Math.round((i * (points.length - 1)) / 47)] ?? [],
			);

export const withForecasts = (
	record: {
		readonly five_hour?: ForecastSeries | undefined;
		readonly seven_day?: ForecastSeries | undefined;
	},
	windows: readonly UsageWindow[],
	readAt: number,
) => {
	const series: { five_hour?: ForecastSeries; seven_day?: ForecastSeries } = {};
	const forecasted = windows.map((window): UsageWindow => {
		if (window.kind !== "five_hour" && window.kind !== "seven_day")
			return window;
		const resetsAt = resetTime(window);
		const next = track(
			series[window.kind] ?? record[window.kind],
			window.utilization,
			resetsAt,
			readAt,
		);
		series[window.kind] = next;
		const forecast = forecastUsage(
			next.points,
			window.utilization,
			resetsAt,
			readAt,
		);
		return {
			...window,
			history: thin(next.points),
			...(forecast === undefined ? {} : { forecast }),
		};
	});
	return { windows: forecasted, series };
};
