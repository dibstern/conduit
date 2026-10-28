import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInThisContext } from "node:vm";

interface SdkRequire {
	(id: string): Record<string, unknown>;
	m: Record<string, (...args: unknown[]) => unknown>;
}

interface ProtoToolCall {
	$(): readonly [string, ...unknown[]];
	fromJson(value: unknown, options: { ignoreUnknownFields: boolean }): unknown;
}

/**
 * @cursor/sdk 1.0.40 declares coreToSdkUpdate in
 * dist/cjs/vendor/cursor-sdk-shared/core-adapter.d.ts, but neither exports it
 * nor ships the corresponding .js. Its exact converter lives inside the
 * local-executor factory in dist/cjs/331.js. Execute that installed source,
 * with the SDK's own protobuf defaults/enums, rather than copying its rules.
 * Only the module loader, generated protobufs and pure converters run. The
 * public entrypoint and local executor are never initialized.
 */
function loadSdkConverter() {
	const require = createRequire(import.meta.url);
	const entry = require.resolve("@cursor/sdk");
	const source = readFileSync(entry, "utf8");
	const requireName = source.match(/([\w$]+)\.m=[\w$]+,/)?.[1];
	const bootstrapEnd = source.search(
		/;var [\w$]+=\{\};[\w$]+\.r\([\w$]+\),[\w$]+\.d\([\w$]+,\{Agent:/,
	);
	if (!requireName || bootstrapEnd < 0)
		throw new Error("Cursor SDK module-loader layout changed");
	const bootstrap = `${source.slice(0, bootstrapEnd)};return ${requireName};})();`;
	const load = runInThisContext(`(function(require){return ${bootstrap}})`, {
		filename: entry,
	}) as (require: NodeJS.Require) => SdkRequire;
	const sdkRequire = load(createRequire(entry));
	for (const file of readdirSync(dirname(entry))) {
		if (!/^\d+\.js$/.test(file)) continue;
		const chunk = require(join(dirname(entry), file)) as {
			modules: SdkRequire["m"];
		};
		Object.assign(sdkRequire.m, chunk.modules);
	}
	const factory = sdkRequire.m["./src/agent/local-executor.ts"]?.toString();
	if (!factory) throw new Error("Cursor SDK local-executor source moved");
	const core = factory.match(
		/function ([\w$]+)\(([\w$]+),[\w$]+\)\{switch\(\2\.message\.case\)\{case"textDelta"/,
	)?.[1];
	const start = factory.search(
		/const [\w$]+=\{\[[\w$]+\.[\w$]+\.UNSPECIFIED\]:"unspecified"/,
	);
	const end = factory.search(
		/const [\w$]+=\{type:"object",properties:\{\},additionalProperties:!0\}/,
	);
	if (!core || start < 0 || end <= start)
		throw new Error("Cursor SDK converter source layout changed");
	const converters = factory.slice(start, end);
	const bindings = [
		...factory.matchAll(/([\w$]+)=r\("([^"]+proto[^"]+)"\)/g),
	].filter(([, alias]) => converters.includes(`${alias}.`));
	const bind = runInThisContext(
		`(function(${bindings.map(([, alias]) => alias).join(",")}){${converters};return ${core}})`,
		{ filename: `${entry}:core-adapter` },
	) as (
		...modules: unknown[]
	) => (update: unknown, sessionId: string) => { toolCall: unknown } | null;
	const convert = bind(...bindings.map(([, , id]) => sdkRequire(id ?? "")));
	const proto = sdkRequire("../proto/dist/generated/agent/v1/agent_pb.js");
	const ToolCall = Object.values(proto).find(
		(value): value is ProtoToolCall =>
			typeof value === "function" &&
			"$" in value &&
			typeof value.$ === "function" &&
			String(value.$()[0]).startsWith("ToolCall|"),
	);
	if (!ToolCall) throw new Error("Cursor SDK ToolCall protobuf moved");
	return (step: Record<string, unknown>) =>
		convert(
			{
				message: {
					case: "toolCallStarted",
					value: {
						toolCall: ToolCall.fromJson(step["toolCall"], {
							ignoreUnknownFields: true,
						}),
					},
				},
			},
			"converter-contract",
		)?.toolCall ?? null;
}

export const sdkToolFromConversationStep = loadSdkConverter();
