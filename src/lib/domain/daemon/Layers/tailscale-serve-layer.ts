import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	Context,
	Data,
	Effect,
	Result as Either,
	Layer,
	Ref,
	Schema,
} from "effect";
import { formatErrorDetail } from "../../../errors.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
} from "../Services/daemon-config-ref.js";

export class TailscaleServeError extends Data.TaggedError(
	"TailscaleServeError",
)<{
	readonly message: string;
}> {}

export class TailscaleCliTag extends Context.Tag("TailscaleCli")<
	TailscaleCliTag,
	{
		readonly exec: (
			args: string[],
		) => Effect.Effect<string, TailscaleServeError>;
	}
>() {}

const execFileAsync = promisify(execFile);
const isMissingBinary = (cause: unknown) =>
	cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export const TailscaleCliLive = Layer.succeed(TailscaleCliTag, {
	exec: (args) =>
		Effect.tryPromise({
			try: async (signal) => {
				const override = process.env["CONDUIT_TAILSCALE_BIN"];
				const options = { encoding: "utf8" as const, timeout: 10_000, signal };
				try {
					return (await execFileAsync(override ?? "tailscale", args, options))
						.stdout;
				} catch (cause) {
					if (
						override !== undefined ||
						process.platform !== "darwin" ||
						!isMissingBinary(cause)
					) {
						throw cause;
					}
					return (
						await execFileAsync(
							"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
							args,
							options,
						)
					).stdout;
				}
			},
			catch: (cause) =>
				new TailscaleServeError({
					message: isMissingBinary(cause)
						? "Tailscale CLI not found. Install Tailscale and put it on PATH or set CONDUIT_TAILSCALE_BIN."
						: `Tailscale ${args.join(" ")} failed: ${formatErrorDetail(cause)}. Check that Tailscale is running and your user can manage Serve.`,
				}),
		}),
});

const TailscaleStatusSchema = Schema.Struct({
	BackendState: Schema.String,
	Self: Schema.optional(
		Schema.NullOr(Schema.Struct({ DNSName: Schema.optional(Schema.String) })),
	),
	CertDomains: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const ServeStatusSchema = Schema.Struct({
	Web: Schema.optional(
		Schema.NullOr(
			Schema.Record({
				key: Schema.String,
				value: Schema.Struct({
					Handlers: Schema.optional(
						Schema.NullOr(
							Schema.Record({
								key: Schema.String,
								value: Schema.Struct({ Proxy: Schema.optional(Schema.String) }),
							}),
						),
					),
				}),
			}),
		),
	),
});

const getTailscaleStatus = Effect.gen(function* () {
	const cli = yield* TailscaleCliTag;
	return yield* Schema.decodeUnknown(Schema.parseJson(TailscaleStatusSchema))(
		yield* cli.exec(["status", "--json"]),
	).pipe(
		Effect.mapError(
			() =>
				new TailscaleServeError({
					message: "Could not read Tailscale status JSON. Update Tailscale.",
				}),
		),
	);
});

export const isTailscaleServeAvailable = getTailscaleStatus.pipe(
	Effect.map(
		(status) =>
			status.BackendState === "Running" &&
			(status.CertDomains?.length ?? 0) > 0 &&
			Boolean(status.Self?.DNSName?.trim().replace(/\.$/, "")),
	),
	Effect.orElseSucceed(() => false),
);

const reconcile = (port: number, enabled: boolean, tlsEnabled: boolean) =>
	Effect.gen(function* () {
		const cli = yield* TailscaleCliTag;
		const status = yield* getTailscaleStatus;
		if (enabled && status.BackendState !== "Running") {
			return yield* new TailscaleServeError({
				message: `Tailscale is not Running (${status.BackendState}). Open Tailscale and sign in, or run tailscale up.`,
			});
		}
		if (enabled && !status.CertDomains?.length) {
			return yield* new TailscaleServeError({
				message:
					"Tailscale HTTPS certificates are disabled. Enable HTTPS certificates on the tailnet admin DNS page (https://login.tailscale.com/admin/dns).",
			});
		}
		const dnsName = status.Self?.DNSName?.trim().replace(/\.$/, "");
		if (!dnsName) {
			return yield* new TailscaleServeError({
				message:
					"Tailscale Self.DNSName is empty. Enable MagicDNS on the tailnet admin DNS page.",
			});
		}
		const serve = yield* Schema.decodeUnknown(
			Schema.parseJson(ServeStatusSchema),
		)(yield* cli.exec(["serve", "status", "--json"])).pipe(
			Effect.mapError(
				() =>
					new TailscaleServeError({
						message:
							"Could not read Tailscale Serve status JSON. Update Tailscale.",
					}),
			),
		);
		const root = serve.Web?.[`${dnsName}:${port}`]?.Handlers?.["/"];
		const httpProxy = `http://127.0.0.1:${port}`;
		const httpsProxy = `https+insecure://127.0.0.1:${port}`;
		const proxy = tlsEnabled ? httpsProxy : httpProxy;
		const ownRoot = root?.Proxy === httpProxy || root?.Proxy === httpsProxy;
		if (!enabled) {
			if (ownRoot) {
				yield* cli.exec(["serve", `--https=${port}`, "--set-path=/", "off"]);
			}
			return undefined;
		}
		if (root !== undefined && !ownRoot) {
			return yield* new TailscaleServeError({
				message: `Tailscale Serve conflict: '/' on ${dnsName}:${port} already serves ${root.Proxy ?? "a file or text handler"}. Move that '/' handler to another path or port.`,
			});
		}
		if (root?.Proxy !== proxy) {
			yield* cli.exec([
				"serve",
				"--bg",
				`--https=${port}`,
				"--set-path=/",
				proxy,
			]);
		}
		return { url: `https://${dnsName}:${port}` };
	});

/** Apply first so a rejected browser change leaves the stored choice intact. */
export const applyTailscaleServe = (enabled: boolean) =>
	Effect.gen(function* () {
		const config = yield* Ref.get(yield* DaemonConfigRefTag);
		const result = yield* reconcile(config.port, enabled, config.tlsEnabled);
		yield* commitDaemonRuntimeConfig((current) => ({
			...current,
			tailscaleServeEnabled: enabled,
			tailscaleServeCleanupPending: false,
			tailscaleServe: result,
		}));
	});

/** Runs after HTTP binds; shutdown deliberately leaves tailscaled's mapping alone. */
export const TailscaleServeLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const config = yield* Ref.get(configRef);
		const enabled = config.tailscaleServeEnabled === true;
		if (!enabled && !config.tailscaleServeCleanupPending) return;
		const result = yield* Effect.either(applyTailscaleServe(enabled));
		if (Either.isLeft(result)) {
			const error = `${result.left.message} Restart conduit with ${enabled ? "--tailscale-serve" : "--no-tailscale-serve"} to retry.`;
			yield* Effect.logWarning(error);
			yield* commitDaemonRuntimeConfig((current) => ({
				...current,
				tailscaleServeCleanupPending: !enabled,
				...(enabled && { tailscaleServe: { error } }),
			}));
			return;
		}
	}),
);
