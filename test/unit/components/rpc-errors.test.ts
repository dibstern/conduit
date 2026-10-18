import { Arbitrary, Effect, Schema, type SchemaAST } from "effect";
import { RpcSchema } from "effect/rpc";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceMoveError } from "../../../src/lib/contracts/session-workspace.js";
import { WorktreeBranchRenameError } from "../../../src/lib/contracts/worktree.js";
import {
	SetPinRejected,
	WsRpcError,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import {
	copy,
	failureLine,
	toastFailure,
} from "../../../src/lib/frontend/transport/rpc-errors.js";

// Failure modes: a new tag is omitted; schema-valid fields break sentence
// functions; null copy or transport failures leak internals; server copy is
// lost; a toast replaces the action title with its reason.
afterEach(() => {
	uiState.toasts = [];
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("requires copy or an explicit null for every declared tag", () => {
	const { WorkspaceMoveError: omitted, ...incomplete } = copy;
	// @ts-expect-error A newly declared tag must be given copy or explicit null.
	const missing: typeof copy = incomplete;
	void missing;
	expect(omitted).toBeTypeOf("function");
});

const checked = new Set<string>();
for (const rpc of WsRpcGroup.requests.values()) {
	const variants: SchemaAST.AST[] = [rpc.errorSchema.ast];
	if (RpcSchema.isStreamSchema(rpc.successSchema))
		variants.push(rpc.successSchema.error.ast);
	for (const ast of variants) {
		if (ast._tag === "Suspend") {
			variants.push(ast.thunk());
			continue;
		}
		if (ast._tag === "Union") {
			variants.push(...ast.types);
			continue;
		}
		if (ast._tag === "Never") continue;
		const schema = Schema.toCodecJson(
			Schema.make<Schema.Codec<unknown, unknown>>(ast),
		);
		const values = Arbitrary.schema(Schema.toEncoded(schema)).pipe(
			Arbitrary.map((wire) =>
				Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(wire))),
			),
		);
		const [example] = await Effect.runPromise(
			Arbitrary.sampleEffect(values, { seed: 42, count: 1 }),
		);
		if (typeof example !== "object" || example === null || !("_tag" in example))
			throw new Error("Expected tagged error");
		const tag = String(example._tag);
		if (checked.has(tag)) continue;
		checked.add(tag);
		it(`never throws for a decoded ${tag}`, async () => {
			vi.useFakeTimers();
			const result = await Effect.runPromise(
				Arbitrary.checkEffect(
					values,
					(error) => {
						expect(() => failureLine(error, "Could not act")).not.toThrow();
						expect(() => toastFailure("Could not act")(error)).not.toThrow();
						expect(uiState.toasts.at(-1)?.title).toBe("Could not act");
						// Message-owning classes retain their message, except branch rename
						// whose existing inline sentence also includes the folder.
						if (
							typeof error === "object" &&
							error !== null &&
							"message" in error &&
							!(error instanceof WorktreeBranchRenameError) &&
							!(error instanceof WorkspaceMoveError) &&
							!(error instanceof SetPinRejected) &&
							error.message
						) {
							expect(failureLine(error, "Could not act")).toBe(error.message);
							expect(uiState.toasts.at(-1)?.body).toBe(error.message);
						}
						return true;
					},
					{ seed: 42, runs: 100 },
				),
			);
			const failure = Arbitrary.formatCheckFailure(result);
			if (failure !== undefined) throw new Error(failure);
		});
	}
}

it("uses the composer's standalone move sentence under the caller's title", () => {
	const error = new WorkspaceMoveError({ path: "/gone", reason: "missing" });
	expect(failureLine(error, "Could not move session")).toBe(
		"That worktree no longer exists.",
	);
	toastFailure("Could not move session", "warn")(error);
	expect(uiState.toasts.at(-1)).toMatchObject({
		title: "Could not move session",
		body: "That worktree no longer exists.",
		variant: "warn",
	});
});

it("uses only the caller's line for null copy, client errors and unknown failures", () => {
	// All current tags already have copy. Exercise the explicitly supported null
	// entry without changing a production sentence or inventing a contract error.
	const original = copy.WorkspaceMoveError;
	Object.assign(copy, { WorkspaceMoveError: null });
	try {
		const error = new WorkspaceMoveError({ path: "/gone", reason: "missing" });
		expect(failureLine(error, "Could not move session")).toBe(
			"Could not move session",
		);
		toastFailure("Could not move session")(error);
		expect(uiState.toasts.at(-1)?.body).toBeUndefined();
	} finally {
		Object.assign(copy, { WorkspaceMoveError: original });
	}
});

it.each([
	undefined,
	null,
	"broken",
	new Error("private detail"),
	new RpcClientError({
		reason: new RpcClientDefect({ message: "socket closed", cause: undefined }),
	}),
	new WsRpcError({ message: "" }),
])("falls back for %s", (error) => {
	expect(failureLine(error, "Could not act")).toBe("Could not act");
	toastFailure("Could not act")(error);
	expect(uiState.toasts.at(-1)).toMatchObject({
		title: "Could not act",
		variant: "error",
	});
	expect(uiState.toasts.at(-1)?.body).toBeUndefined();
});

it("preserves the server message under the caller's title", () => {
	const error = new WsRpcError({ message: "Permission denied" });
	expect(failureLine(error, "Could not act")).toBe("Permission denied");
	toastFailure("Could not act")(error);
	expect(uiState.toasts.at(-1)).toMatchObject({
		title: "Could not act",
		body: "Permission denied",
	});
});

it.each([
	["wrong_pin", undefined, "Wrong PIN. Try again."],
	["locked_out", undefined, "Too many tries. Try again in 1 minute."],
	["locked_out", 61, "Too many tries. Try again in 2 minutes."],
] as const)("preserves PIN copy for %s/%s", (reason, retryAfterSeconds, sentence) => {
	expect(
		failureLine(
			new SetPinRejected({
				reason,
				...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
			}),
			"Could not save PIN",
		),
	).toBe(sentence);
});
