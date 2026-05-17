import { Data, Schema } from "effect";
import {
	OpenCodeMessageWithPartsSchema,
	OpenCodePendingPermissionSchema,
	OpenCodePendingQuestionSchema,
	OpenCodeQuestionRejectRequestSchema,
	OpenCodeQuestionReplyRequestSchema,
} from "../contracts/providers/opencode-sdk.js";
import { OpenCodeApiError } from "../errors.js";

const OpenCodeSkillSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
});
const OpenCodeSkillArraySchema = Schema.Array(
	OpenCodeSkillSchema,
) as unknown as Schema.Schema<Array<{ name: string; description?: string }>>;
const OpenCodePendingPermissionArraySchema = Schema.Array(
	OpenCodePendingPermissionSchema,
) as unknown as Schema.Schema<unknown[]>;
const OpenCodePendingQuestionArraySchema = Schema.Array(
	OpenCodePendingQuestionSchema,
) as unknown as Schema.Schema<unknown[]>;
const OpenCodeMessageWithPartsArraySchema = Schema.Array(
	OpenCodeMessageWithPartsSchema,
) as unknown as Schema.Schema<unknown[]>;

export interface GapEndpointsOptions {
	baseUrl: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
}

export class GapEndpointHttpError extends Data.TaggedError(
	"GapEndpointHttpError",
)<{
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly status: number;
}> {
	override get message(): string {
		return `${this.method} ${this.path} failed: ${this.status}`;
	}
}

export class GapEndpoints {
	private readonly baseUrl: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly headers: Record<string, string>;

	constructor(options: GapEndpointsOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetch = options.fetch ?? globalThis.fetch;
		this.headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
			...options.headers,
		};
	}

	async listPendingPermissions(): Promise<unknown[]> {
		return this.get("/permission", OpenCodePendingPermissionArraySchema);
	}

	async listPendingQuestions(): Promise<unknown[]> {
		return this.get("/question", OpenCodePendingQuestionArraySchema);
	}

	async replyQuestion(id: string, answers: string[][]): Promise<void> {
		await this.post(
			`/question/${id}/reply`,
			{ answers },
			OpenCodeQuestionReplyRequestSchema,
			Schema.Undefined,
		);
	}

	async rejectQuestion(id: string): Promise<void> {
		await this.post(
			`/question/${id}/reject`,
			{},
			OpenCodeQuestionRejectRequestSchema,
			Schema.Undefined,
		);
	}

	async listSkills(
		directory?: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const path = directory
			? `/skill?directory=${encodeURIComponent(directory)}`
			: "/skill";
		return this.get(path, OpenCodeSkillArraySchema);
	}

	async getMessagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<unknown[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.before) params.set("before", options.before);
		const query = params.toString();
		const path = `/session/${sessionId}/message${query ? `?${query}` : ""}`;
		return this.get(path, OpenCodeMessageWithPartsArraySchema);
	}

	private async get<T>(path: string, schema: Schema.Schema<T>): Promise<T> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "GET",
				headers: this.headers,
			}),
		);
		if (!res.ok) {
			throw new GapEndpointHttpError({
				method: "GET",
				path,
				status: res.status,
			});
		}
		const data =
			res.status === 204
				? undefined
				: await parseJsonResponse("GET", path, res.status, res);
		return decodeGapResponse("GET", path, res.status, schema, data);
	}

	private async post<T, Body>(
		path: string,
		body: unknown,
		requestSchema: Schema.Schema<Body>,
		responseSchema: Schema.Schema<T>,
	): Promise<T> {
		const decodedBody = decodeGapRequest("POST", path, requestSchema, body);
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.headers,
				body: JSON.stringify(decodedBody),
			}),
		);
		if (!res.ok) {
			throw new GapEndpointHttpError({
				method: "POST",
				path,
				status: res.status,
			});
		}
		let data: unknown;
		if (res.status !== 204) {
			const ct = res.headers.get("content-type") ?? "";
			if (ct.includes("application/json")) {
				data = await parseJsonResponse("POST", path, res.status, res);
			}
		}
		return decodeGapResponse("POST", path, res.status, responseSchema, data);
	}
}

async function parseJsonResponse(
	method: "GET" | "POST",
	path: string,
	status: number,
	res: Response,
): Promise<unknown> {
	try {
		return await res.json();
	} catch (err) {
		throw toMalformedGapError({
			message: `Malformed OpenCode gap JSON during ${method} ${path}`,
			method,
			path,
			status,
			err,
		});
	}
}

function decodeGapRequest<T>(
	method: "POST",
	path: string,
	schema: Schema.Schema<T>,
	data: unknown,
): T {
	try {
		return Schema.decodeUnknownSync(schema)(data);
	} catch (err) {
		throw toMalformedGapError({
			message: `Malformed OpenCode gap request during ${method} ${path}`,
			method,
			path,
			status: 400,
			err,
		});
	}
}

function decodeGapResponse<T>(
	method: "GET" | "POST",
	path: string,
	status: number,
	schema: Schema.Schema<T>,
	data: unknown,
): T {
	try {
		return Schema.decodeUnknownSync(schema)(data);
	} catch (err) {
		throw toMalformedGapError({
			message: `Malformed OpenCode gap response during ${method} ${path}`,
			method,
			path,
			status,
			err,
		});
	}
}

function toMalformedGapError(options: {
	message: string;
	method: "GET" | "POST";
	path: string;
	status: number;
	err: unknown;
}): OpenCodeApiError {
	const cause =
		options.err instanceof Error ? options.err : new Error(String(options.err));
	const parseDetails = cause.message.slice(0, 2000);
	return new OpenCodeApiError({
		message: options.message,
		endpoint: options.path,
		responseStatus: options.status,
		responseBody: { parseDetails },
		cause,
		context: {
			method: options.method,
			path: options.path,
			parseDetails,
		},
	});
}
