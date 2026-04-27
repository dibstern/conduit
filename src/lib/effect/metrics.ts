import { Metric, MetricBoundaries } from "effect";

export const wsConnectionsGauge = Metric.gauge("conduit.ws.connections");
export const activePollersGauge = Metric.gauge("conduit.pollers.active");
export const sseReconnectsCounter = Metric.counter("conduit.sse.reconnects");
export const rateLimitRejectionsCounter = Metric.counter(
	"conduit.rate_limit.rejections",
);
export const ipcCommandsCounter = Metric.counter("conduit.ipc.commands");
export const configPersistsCounter = Metric.counter("conduit.config.persists");
export const ipcLatencyHistogram = Metric.histogram(
	"conduit.ipc.latency_ms",
	MetricBoundaries.exponential({ start: 1, factor: 2, count: 12 }),
);
