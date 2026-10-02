// Deterministic CLI fixture: expose batch-level pauses without running providers.
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";

type Mark =
	| { kind: "query"; sessionId: string }
	| { kind: "receipt" | "enqueue"; prompt: string; at: string }
	| { kind: "emit"; prompt: string; text: string; at: string };

export function responseChunks(prompt: string): string[] {
	return [`Echo(${prompt}): `, `stream(${prompt}) `, `done(${prompt}).`];
}

export class ProcessHarness {
	readonly marks: Mark[] = [{ kind: "query", sessionId: "fixture-session" }];
	private sends = 0;
	private readonly frames: Array<{
		message: Record<string, unknown>;
		at: bigint;
	}> = [];
	private constructor(private readonly dist: string) {}
	static async start({ dist }: { dist: string }): Promise<ProcessHarness> {
		const config = JSON.parse(
			readFileSync(`${dist}/latencies.json`, "utf8"),
		) as { failActivation?: boolean };
		if (config.failActivation)
			throw new Error("Fake Claude SDK activation was not acknowledged");
		return new ProcessHarness(dist);
	}
	async connect() {
		const config = JSON.parse(
			readFileSync(`${this.dist}/latencies.json`, "utf8"),
		) as {
			enqueue: number[];
			forward: number[];
			trace: string;
			promptTrace: string;
		};
		return {
			frames: this.frames,
			createSession: async () => "fixture-session",
			send: async (_sessionId: string, prompt: string) => {
				appendFileSync(config.promptTrace, "send\n");
				const warmup = prompt.includes("-warmup-");
				const batch = Math.floor(this.sends / 200);
				if (!warmup) {
					if (this.sends % 200 === 0)
						appendFileSync(config.trace, `${basename(this.dist)}\n`);
					this.sends++;
				}
				const receipt = 1_000_000_000n;
				const enqueue =
					receipt + BigInt(Math.round((config.enqueue[batch] ?? 10) * 1e6));
				this.marks.push(
					{ kind: "receipt", prompt, at: receipt.toString() },
					{ kind: "enqueue", prompt, at: enqueue.toString() },
				);
				for (const text of responseChunks(prompt)) {
					this.marks.push({
						kind: "emit",
						prompt,
						text,
						at: enqueue.toString(),
					});
					this.frames.push({
						message: { type: "delta", text },
						at:
							enqueue + BigInt(Math.round((config.forward[batch] ?? 1) * 1e6)),
					});
				}
				return { chunks: responseChunks(prompt) };
			},
		};
	}
	async dispose(): Promise<void> {}
}
