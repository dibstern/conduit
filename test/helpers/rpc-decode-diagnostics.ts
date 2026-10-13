import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Rpc, RpcSchema, RpcSerialization } from "@effect/rpc";
import { Either, Option, ParseResult, Schema } from "effect";
import { WsRpcGroup } from "../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../src/lib/utils.js";

export interface RpcBuildIdentity {
	readonly client: "source";
	readonly server: "source" | "dist";
	readonly dist: string | null;
	readonly buildId: string | null;
	/** mtime of the build-stamped module, including server-only builds. */
	readonly builtAt: string | null;
}

const AUTH_FIELD =
	/^(?:auth|authorization|proxy-authorization|cookie|set-cookie)$|password|passwd|token|secret|api[_-]?key|credential/i;

function redactString(value: string): string {
	return value
		.replace(/(\b[a-z]+:\/\/)[^/\s@"']+:[^/\s@"']+@/gi, "$1[REDACTED]@")
		.replace(/\b(Basic|Bearer)\s+[\w+/.~=-]+/gi, "$1 [REDACTED]")
		.replace(
			/([?&](?:password|token|api[_-]?key|secret)=)[^&#\s"']+/gi,
			"$1[REDACTED]",
		);
}

function redactPayload(raw: string): string {
	try {
		const value: unknown = JSON.parse(raw);
		return JSON.stringify(
			value,
			function (this: unknown, key: string, value: unknown) {
				if (
					AUTH_FIELD.test(key) ||
					(key === "1" &&
						Array.isArray(this) &&
						typeof this[0] === "string" &&
						AUTH_FIELD.test(this[0]))
				)
					return "[REDACTED]";
				return typeof value === "string" ? redactString(value) : value;
			},
		);
	} catch {
		// Framing failures still need evidence without exposing partial JSON auth.
		return redactString(
			raw.replace(
				/"([^"\\]+)"(\s*:\s*)"(?:\\.|[^"\\])*(?:"|$)/g,
				(match, key: string, separator: string) =>
					AUTH_FIELD.test(key) ? `"${key}"${separator}"[REDACTED]"` : match,
			),
		);
	}
}

/** Observe the source schemas at the wire boundary without replacing RPC errors. */
export class RpcDecodeDiagnostics {
	readonly wireFrames: {
		endpoint: string;
		bytes: number;
		rpcs: string[];
		detailParts: { messageId: string; bytes: number; suffix: boolean }[];
	}[] = [];
	readonly failures: {
		endpoint: string;
		rpc: string | null;
		requestId: string | null;
		rawPayload: string;
		schemaPaths: (string | number)[][];
		build: RpcBuildIdentity;
	}[] = [];

	constructor(
		public buildIdentity: RpcBuildIdentity,
		private readonly artifactPath?: string,
	) {}

	capture(
		endpoint: string,
		rpc: string | null,
		rawPayload: string,
		error: unknown,
		prefix: (string | number)[] = [],
		requestId: string | null = null,
	): void {
		const schemaPaths = ParseResult.isParseError(error)
			? ParseResult.ArrayFormatter.formatErrorSync(error).map(({ path }) => [
					...prefix,
					...path.map((part) =>
						typeof part === "symbol" ? String(part) : part,
					),
				])
			: [[]];
		this.failures.push({
			endpoint,
			rpc,
			requestId,
			rawPayload: redactPayload(rawPayload),
			// Literal unions report one issue per member at the same path.
			schemaPaths: [
				...new Map(
					schemaPaths.map((path) => [JSON.stringify(path), path]),
				).values(),
			],
			build: this.buildIdentity,
		});
		// Startup can fail before ProcessHarness.start returns an owner for proof().
		if (this.artifactPath) {
			mkdirSync(dirname(this.artifactPath), { recursive: true });
			writeFileSync(
				this.artifactPath,
				JSON.stringify(
					{
						buildIdentity: this.buildIdentity,
						rpcDecodeFailures: this.failures,
					},
					null,
					2,
				),
			);
		}
	}

	serialization(endpoint: string): RpcSerialization.RpcSerialization["Type"] {
		return RpcSerialization.RpcSerialization.of({
			...RpcSerialization.json,
			unsafeMake: () => {
				const parser = RpcSerialization.json.unsafeMake();
				const requests = new Map<string, string>();
				return {
					encode: (message) => {
						if (isRecord(message)) {
							if (
								message["_tag"] === "Request" &&
								typeof message["tag"] === "string"
							)
								requests.set(String(message["id"]), message["tag"]);
							else if (message["_tag"] === "Interrupt")
								requests.delete(String(message["requestId"]));
						}
						return parser.encode(message);
					},
					decode: (data) => {
						const raw =
							typeof data === "string" ? data : new TextDecoder().decode(data);
						let frames: ReadonlyArray<unknown>;
						try {
							frames = parser.decode(data);
						} catch (error) {
							this.capture(endpoint, null, raw, error);
							throw error;
						}
						this.wireFrames.push({
							endpoint,
							bytes: new TextEncoder().encode(raw).byteLength,
							rpcs: [
								...new Set(
									frames.flatMap((frame) => {
										if (!isRecord(frame)) return [];
										const tag = requests.get(String(frame["requestId"]));
										return tag ? [tag] : [];
									}),
								),
							],
							detailParts: frames.flatMap((frame) => {
								if (
									!isRecord(frame) ||
									requests.get(String(frame["requestId"])) !==
										"SubscribeSessionDetail" ||
									!Array.isArray(frame["values"])
								)
									return [];
								return frame["values"].flatMap((envelope: unknown) => {
									if (!isRecord(envelope)) return [];
									const rows: unknown[] =
										envelope["_tag"] === "snapshot" &&
										Array.isArray(envelope["rows"])
											? envelope["rows"]
											: envelope["_tag"] === "upsert"
												? [envelope["item"]]
												: [];
									return rows.flatMap((row) => {
										if (
											!isRecord(row) ||
											row["_tag"] !== "part" ||
											typeof row["messageId"] !== "string" ||
											!isRecord(row["part"]) ||
											row["part"]["type"] !== "text" ||
											typeof row["part"]["text"] !== "string"
										)
											return [];
										return [
											{
												messageId: row["messageId"],
												bytes: new TextEncoder().encode(row["part"]["text"])
													.byteLength,
												suffix: envelope["textSuffix"] !== undefined,
											},
										];
									});
								});
							}),
						});
						for (const frame of frames) {
							if (!isRecord(frame)) continue;
							const requestId = String(frame["requestId"]);
							const tag = requests.get(requestId);
							const rpc = tag ? WsRpcGroup.requests.get(tag) : undefined;
							if (!rpc) continue;
							let schema: Schema.Schema<unknown, unknown>;
							let payload: unknown;
							let prefix: string;
							if (frame["_tag"] === "Exit") {
								// Same exit schema used by RpcClient.make, with no schema context.
								schema = Schema.make(Rpc.exitSchema(rpc).ast);
								payload = frame["exit"];
								prefix = "exit";
								requests.delete(requestId);
							} else if (frame["_tag"] === "Chunk") {
								const stream = RpcSchema.getStreamSchemas(
									rpc.successSchema.ast,
								);
								if (Option.isNone(stream)) continue;
								schema = Schema.make(
									Schema.NonEmptyArray(stream.value.success).ast,
								);
								payload = frame["values"];
								prefix = "values";
							} else continue;
							const decoded = Schema.decodeUnknownEither(schema)(payload);
							if (Either.isLeft(decoded))
								this.capture(
									endpoint,
									rpc._tag,
									raw,
									decoded.left,
									[prefix],
									requestId,
								);
						}
						return frames;
					},
				};
			},
		});
	}
}
