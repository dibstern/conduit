import { Metric } from "effect";

export const wsConnectionsGauge = Metric.gauge("conduit.ws.connections");
export const activePollersGauge = Metric.gauge("conduit.pollers.active");
export const sseReconnectsCounter = Metric.counter("conduit.sse.reconnects");
export const rateLimitRejectionsCounter = Metric.counter(
	"conduit.rate_limit.rejections",
);
export const configPersistsCounter = Metric.counter("conduit.config.persists");
