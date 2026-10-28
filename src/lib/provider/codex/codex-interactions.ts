import { Deferred, Effect, Result, Schema } from "effect";
import type { SessionPermissionMode } from "../../shared-types.js";
import type { EventSinkError } from "../event-sink-errors.js";
import type { EventSink, PermissionDecision } from "../types.js";
import { SERVER_REQUEST_RESOLVED } from "./app-server/client.js";
import {
	CommandExecutionRequestApprovalParamsSchema,
	FileChangeRequestApprovalParamsSchema,
	McpServerElicitationRequestParamsSchema,
	PermissionsRequestApprovalParamsSchema,
	ToolRequestUserInputParamsSchema,
} from "./app-server/protocol.js";
import type { CodexItemState } from "./codex-item-mapper.js";

type Cancellation = "cancel" | typeof SERVER_REQUEST_RESOLVED;

const ElicitationForm = Schema.Struct({
	type: Schema.Literal("object"),
	properties: Schema.Record(Schema.String, Schema.Unknown),
	required: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const ElicitationOption = Schema.Struct({
	const: Schema.String,
	title: Schema.String,
});
const ElicitationField = Schema.Struct({
	type: Schema.Literals(["string", "number", "integer", "boolean", "array"]),
	title: Schema.optional(Schema.NullOr(Schema.String)),
	description: Schema.optional(Schema.NullOr(Schema.String)),
	enum: Schema.optional(Schema.Array(Schema.String)),
	enumNames: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
	oneOf: Schema.optional(Schema.Array(ElicitationOption)),
	items: Schema.optional(
		Schema.Struct({
			type: Schema.optional(Schema.Literal("string")),
			enum: Schema.optional(Schema.Array(Schema.String)),
			anyOf: Schema.optional(Schema.Array(ElicitationOption)),
		}),
	),
	minimum: Schema.optional(Schema.NullOr(Schema.Number)),
	maximum: Schema.optional(Schema.NullOr(Schema.Number)),
	minLength: Schema.optional(Schema.NullOr(Schema.Number)),
	maxLength: Schema.optional(Schema.NullOr(Schema.Number)),
	minItems: Schema.optional(Schema.NullOr(Schema.Number)),
	maxItems: Schema.optional(Schema.NullOr(Schema.Number)),
	format: Schema.optional(Schema.NullOr(Schema.String)),
});

/** The detached runner owns the waits; daemon attachment and replay stay generic. */
export class CodexInteractions {
	private readonly pending = new Map<
		string | number,
		{
			readonly cancel: Deferred.Deferred<Cancellation>;
			readonly requestId: string;
			readonly kind: "permission" | "question";
		}
	>();
	private readonly resolved = new Set<string | number>();
	private readonly itemWaiters = new Map<string, Deferred.Deferred<void>>();
	private interrupted = false;

	constructor(
		private readonly sink: EventSink,
		private readonly permissionMode: SessionPermissionMode | undefined,
		private readonly state: () => CodexItemState,
		private readonly withdraw: (
			requestId: string,
			kind: "permission" | "question",
		) => Effect.Effect<void, unknown>,
		private readonly diagnostic: (
			message: string,
			requestId: string,
		) => Effect.Effect<void, EventSinkError>,
	) {}

	request(method: string, params: unknown, id: string | number) {
		switch (method) {
			case "mcpServer/elicitation/request":
				return Schema.decodeUnknownEffect(
					McpServerElicitationRequestParamsSchema,
				)(params).pipe(
					Effect.flatMap((request) => this.elicitation(request, id)),
				);
			case "item/commandExecution/requestApproval":
				return this.approval(
					method,
					Schema.decodeUnknownEffect(
						CommandExecutionRequestApprovalParamsSchema,
					)(params),
					id,
				);
			case "item/fileChange/requestApproval":
				return this.approval(
					method,
					Schema.decodeUnknownEffect(FileChangeRequestApprovalParamsSchema)(
						params,
					),
					id,
				);
			case "item/permissions/requestApproval":
				return this.approval(
					method,
					Schema.decodeUnknownEffect(PermissionsRequestApprovalParamsSchema)(
						params,
					),
					id,
				);
			case "item/tool/requestUserInput":
				return Schema.decodeUnknownEffect(ToolRequestUserInputParamsSchema)(
					params,
				).pipe(
					Effect.flatMap((request) =>
						this.wait(
							id,
							{ answers: {} },
							Effect.gen({ self: this }, function* () {
								if (!this.matches(request)) return { answers: {} };
								const runId = this.state().runId;
								const answers = yield* this.sink.requestQuestion({
									requestId: request.itemId,
									...(runId ? { runId } : {}),
									toolUseId: request.itemId,
									questions: request.questions.map((question) => ({
										question: question.question,
										header: question.header,
										options: [...(question.options ?? [])],
										custom: question.isOther ?? false,
										isOther: question.isOther ?? false,
										isSecret: question.isSecret ?? false,
									})),
								});
								return {
									answers: Object.fromEntries(
										request.questions.map((question, index) => {
											const answer = answers[String(index)];
											return [
												question.id,
												{
													answers:
														typeof answer === "string"
															? [answer]
															: Array.isArray(answer)
																? answer.filter(
																		(value): value is string =>
																			typeof value === "string",
																	)
																: [],
												},
											];
										}),
									),
								};
							}),
							request.itemId,
							"question",
						),
					),
				);
			default:
				return undefined;
		}
	}

	resolve(requestId: string | number) {
		return Effect.gen({ self: this }, function* () {
			this.resolved.add(requestId);
			const pending = this.pending.get(requestId);
			if (pending) {
				yield* Deferred.succeed(pending.cancel, SERVER_REQUEST_RESOLVED);
				// Emit before processing turn completion can release the runner sink.
				yield* this.withdraw(pending.requestId, pending.kind);
			}
		});
	}

	interrupt() {
		return Effect.gen({ self: this }, function* () {
			this.interrupted = true;
			for (const pending of this.pending.values())
				yield* Deferred.succeed(pending.cancel, "cancel");
		});
	}

	/** Item notifications and server callbacks run independently in the client. */
	itemMapped(itemId: string) {
		const waiter = this.itemWaiters.get(itemId);
		return waiter
			? Deferred.succeed(waiter, undefined).pipe(Effect.asVoid)
			: Effect.void;
	}

	private matches(request: {
		threadId: string;
		turnId?: string | null | undefined;
	}) {
		const state = this.state();
		return (
			request.threadId === state.threadId &&
			(request.turnId == null ||
				state.nativeTurnId === undefined ||
				request.turnId === state.nativeTurnId)
		);
	}

	private elicitation(
		request: typeof McpServerElicitationRequestParamsSchema.Type,
		id: string | number,
	) {
		const requestId = `${this.state().messageId}:elicitation:${id}`;
		const decoded = Schema.decodeUnknownResult(ElicitationForm)(
			request.requestedSchema,
		);
		const consent =
			request.mode === "form" &&
			Result.isSuccess(decoded) &&
			Object.keys(decoded.success.properties).length === 0;
		const decline = (reason: string) =>
			this.diagnostic(
				`MCP elicitation from ${request.serverName} declined: ${reason}`,
				requestId,
			).pipe(Effect.as({ action: "decline" }));
		return this.wait<
			{
				action: string;
				content?: Record<string, string | number | boolean | string[]>;
			},
			EventSinkError
		>(
			id,
			{ action: "cancel" },
			Effect.gen({ self: this }, function* () {
				if (!this.matches(request)) return { action: "cancel" };
				if (request.mode !== "form")
					return yield* decline(`unsupported ${request.mode} mode`);
				if (Result.isFailure(decoded))
					return yield* decline("unsupported form schema");
				const schema = decoded.success;
				const fields = Object.entries(schema.properties);
				if (
					(schema.required ?? []).some(
						(name) => !Object.hasOwn(schema.properties, name),
					)
				)
					return yield* decline("required field is absent from the schema");
				if (!fields.length) {
					const runId = this.state().runId;
					const { decision } = yield* this.sink.requestPermission({
						requestId,
						...(runId ? { runId } : {}),
						providerItemId: requestId,
						sessionId: this.state().sessionId,
						turnId: this.state().turnId,
						toolName: "McpElicitation",
						toolInput: {
							serverName: request.serverName,
							message: request.message,
						},
						always: [],
					});
					return { action: decision === "reject" ? "decline" : "accept" };
				}
				const parsed = [];
				for (const [name, raw] of fields) {
					const field = Schema.decodeUnknownResult(ElicitationField)(raw);
					if (Result.isFailure(field))
						return yield* decline(`unsupported field ${name}`);
					const value = field.success;
					if (value.format)
						return yield* decline(
							`unsupported format for ${name}: ${value.format}`,
						);
					const choices = value.type === "array" ? value.items : value;
					const titled =
						choices &&
						("anyOf" in choices
							? choices.anyOf
							: "oneOf" in choices
								? choices.oneOf
								: undefined);
					const options =
						value.type === "boolean"
							? [
									{ label: "Yes", value: true },
									{ label: "No", value: false },
								]
							: titled
								? titled.map((option) => ({
										label: option.title,
										value: option.const,
									}))
								: (choices?.enum ?? []).map((option, index) => ({
										label: value.enumNames?.[index] ?? option,
										value: option,
									}));
					if (
						((value.type === "array" ||
							value.enum !== undefined ||
							value.oneOf !== undefined) &&
							!options.length) ||
						new Set(options.map(({ label }) => label)).size !==
							options.length ||
						(value.type === "array" &&
							options.some(({ label }) => label.includes(",")))
					)
						return yield* decline(`unsupported options for ${name}`);
					parsed.push({ name, field: value, options });
				}
				const runId = this.state().runId;
				const answers = yield* this.sink
					.requestQuestion({
						requestId,
						...(runId ? { runId } : {}),
						toolUseId: requestId,
						questions: parsed.map(({ name, field, options }) => ({
							header: field.title ?? name,
							question: `${request.serverName}: ${request.message}\n${field.description ?? field.title ?? name}`,
							options: options.map(({ label }) => ({ label, description: "" })),
							multiSelect: field.type === "array",
							custom: options.length === 0,
						})),
					})
					.pipe(
						Effect.catchIf(
							(failure) =>
								failure._tag === "EventSinkIngestionError" &&
								typeof failure.cause === "object" &&
								failure.cause !== null &&
								"code" in failure.cause &&
								failure.cause.code === "question_rejected",
							() => Effect.succeed<Record<string, unknown>>({}),
						),
					);
				if (!Object.keys(answers).length) return { action: "decline" };
				const content: Record<string, string | number | boolean | string[]> =
					Object.create(null);
				for (const [index, { name, field, options }] of parsed.entries()) {
					const answer = answers[String(index)];
					if (
						answer === undefined ||
						answer === "" ||
						(Array.isArray(answer) && !answer.length)
					) {
						if (schema.required?.includes(name))
							return yield* decline(`missing required field ${name}`);
						continue;
					}
					if (field.type === "array") {
						const labels =
							typeof answer === "string"
								? answer.split(",").map((label) => label.trim())
								: Array.isArray(answer)
									? answer
									: [];
						const values: string[] = [];
						for (const label of labels) {
							const option = options.find((option) => option.label === label);
							if (!option || typeof option.value !== "string")
								return yield* decline(`invalid option for ${name}`);
							values.push(option.value);
						}
						if (
							(field.minItems != null && values.length < field.minItems) ||
							(field.maxItems != null && values.length > field.maxItems)
						)
							return yield* decline(`invalid selection count for ${name}`);
						content[name] = values;
					} else if (options.length) {
						const option = options.find((option) => option.label === answer);
						if (!option) return yield* decline(`invalid option for ${name}`);
						content[name] = option.value;
					} else if (field.type === "number" || field.type === "integer") {
						const number =
							typeof answer === "string" &&
							/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(answer.trim())
								? Number(answer)
								: Number.NaN;
						if (
							!Number.isFinite(number) ||
							(field.type === "integer" && !Number.isInteger(number)) ||
							(field.minimum != null && number < field.minimum) ||
							(field.maximum != null && number > field.maximum)
						)
							return yield* decline(`invalid ${field.type} for ${name}`);
						content[name] = number;
					} else {
						if (
							typeof answer !== "string" ||
							(field.minLength != null &&
								[...answer].length < field.minLength) ||
							(field.maxLength != null && [...answer].length > field.maxLength)
						)
							return yield* decline(`invalid string for ${name}`);
						content[name] = answer;
					}
				}
				return { action: "accept", content };
			}),
			requestId,
			consent ? "permission" : "question",
		);
	}

	private approval(
		method: string,
		decoded: Effect.Effect<
			| typeof CommandExecutionRequestApprovalParamsSchema.Type
			| typeof FileChangeRequestApprovalParamsSchema.Type
			| typeof PermissionsRequestApprovalParamsSchema.Type,
			Schema.SchemaError
		>,
		id: string | number,
	) {
		return decoded.pipe(
			Effect.flatMap((request) => {
				const requestId =
					"approvalId" in request
						? (request.approvalId ?? request.itemId)
						: request.itemId;
				const permissions =
					"permissions" in request ? request.permissions : undefined;
				const cancelled = permissions
					? { permissions: {}, scope: "turn" }
					: { decision: "cancel" };
				return this.wait(
					id,
					cancelled,
					Effect.gen({ self: this }, function* () {
						if (!this.matches(request)) return cancelled;
						const response = (decision: PermissionDecision) =>
							permissions
								? {
										permissions: decision === "reject" ? {} : permissions,
										scope: decision === "always" ? "session" : "turn",
									}
								: {
										decision:
											decision === "reject"
												? "decline"
												: decision === "always" &&
														"availableDecisions" in request &&
														request.availableDecisions?.includes(
															"acceptForSession",
														)
													? "acceptForSession"
													: "accept",
									};
						if (this.permissionMode === "full") return response("once");
						const fileChange = method === "item/fileChange/requestApproval";
						let item = this.state().parts.find(
							(part) => part.kind === "tool" && part.itemId === request.itemId,
						);
						if (fileChange && !item) {
							const mapped = Deferred.makeUnsafe<void>();
							this.itemWaiters.set(request.itemId, mapped);
							yield* Deferred.await(mapped).pipe(
								Effect.ensuring(
									Effect.sync(() => this.itemWaiters.delete(request.itemId)),
								),
							);
							item = this.state().parts.find(
								(part) =>
									part.kind === "tool" && part.itemId === request.itemId,
							);
						}
						const filePaths =
							item?.kind === "tool" && item.input.tool === "Patch"
								? item.input.filePaths
								: [];
						const toolName = permissions
							? "Permissions"
							: fileChange
								? "Edit"
								: "Bash";
						const toolInput = permissions
							? { permissions, cwd: "cwd" in request ? request.cwd : undefined }
							: fileChange
								? { file_path: filePaths[0], filePaths }
								: {
										command:
											"command" in request ? (request.command ?? "") : "",
										cwd: "cwd" in request ? request.cwd : undefined,
									};
						const runId = this.state().runId;
						const { decision } = yield* this.sink.requestPermission({
							requestId,
							...(runId ? { runId } : {}),
							providerItemId: request.itemId,
							sessionId: this.state().sessionId,
							turnId: this.state().turnId,
							toolName,
							toolInput,
							always: permissions
								? [JSON.stringify(permissions)]
								: fileChange
									? [...filePaths]
									: ["command" in request ? (request.command ?? "") : ""],
							...(request.reason ? { permissionReason: request.reason } : {}),
						});
						return response(decision);
					}),
					requestId,
					"permission",
				);
			}),
		);
	}

	private wait<A, E>(
		id: string | number,
		cancelled: A,
		effect: Effect.Effect<A, E>,
		requestId: string,
		kind: "permission" | "question",
	) {
		return Effect.gen({ self: this }, function* () {
			if (this.resolved.has(id)) return SERVER_REQUEST_RESOLVED;
			if (this.interrupted) return cancelled;
			// Register before yielding so a resolved notification cannot overtake us.
			const pending = Deferred.makeUnsafe<Cancellation>();
			this.pending.set(id, { cancel: pending, requestId, kind });
			return yield* effect.pipe(
				Effect.raceFirst(
					Deferred.await(pending).pipe(
						Effect.map((reason) =>
							reason === "cancel" ? cancelled : SERVER_REQUEST_RESOLVED,
						),
					),
				),
				Effect.ensuring(Effect.sync(() => this.pending.delete(id))),
			);
		});
	}
}
