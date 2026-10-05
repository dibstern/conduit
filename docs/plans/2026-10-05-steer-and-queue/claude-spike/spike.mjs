// Throwaway spike: how does the Claude Agent SDK report a message sent mid-turn?
// Usage: node spike.mjs <scenario>   (steer-tool | steer-text | later | multi | now | interrupt)
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

const scenario = process.argv[2];
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
const log = (...a) => console.log(ts(), ...a);
const short = (s, n = 90) => JSON.stringify(String(s ?? "")).slice(0, n);

// Minimal push-based AsyncIterable for streaming input.
const pending = [];
let wake;
let closed = false;
const input = {
	async *[Symbol.asyncIterator]() {
		while (!closed || pending.length) {
			if (pending.length) yield pending.shift();
			else await new Promise((r) => (wake = r));
		}
	},
};
const ids = {};
function send(label, text, extra = {}) {
	const uuid = randomUUID();
	ids[uuid] = label;
	pending.push({
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		uuid,
		...extra,
	});
	log(`>>> SEND ${label} ${JSON.stringify(extra)} ${short(text, 70)}`);
	wake?.();
}
const name = (u) => (u ? (ids[u] ?? u.slice(0, 8)) : "-");

const SLEEP =
	"Use the Bash tool to run exactly `sleep 15; echo A-DONE`. After it finishes, reply with one short sentence.";
const STORY =
	"Without using any tools, write a 250-word story about a lighthouse keeper.";
const STEER = "Also: end your next reply with the word BANANA.";

const plans = {
	"steer-tool": {
		first: SLEEP,
		onToolUse: () => send("B", STEER, { priority: "next" }),
	},
	"steer-text": {
		first: STORY,
		onFirstText: () => send("B", STEER, { priority: "next" }),
	},
	later: {
		first: SLEEP,
		onToolUse: () => send("B", STEER, { priority: "later" }),
	},
	multi: {
		first: SLEEP,
		onToolUse: () => {
			send("B", STEER, { priority: "next" });
			setTimeout(
				() => send("C", "Also mention the word CHERRY.", { priority: "next" }),
				1500,
			);
		},
	},
	now: {
		first: SLEEP,
		onToolUse: () =>
			send("B", STEER, { priority: "now", origin: { kind: "human" } }),
	},
	"interrupt-steer": {
		first: SLEEP,
		onToolUse: async (q) => {
			send("B", STEER, { priority: "next" });
			await new Promise((r) => setTimeout(r, 1500));
			log("!!! interrupt()");
			log("!!! receipt", JSON.stringify(await q.interrupt()));
		},
	},
	interrupt: {
		first: SLEEP,
		onToolUse: async (q) => {
			send("B", STEER, { priority: "later" });
			await new Promise((r) => setTimeout(r, 1500));
			log("!!! interrupt()");
			log("!!! receipt", JSON.stringify(await q.interrupt()));
		},
	},
};
const plan = plans[scenario];
if (!plan) throw new Error(`unknown scenario ${scenario}`);

const q = query({
	prompt: input,
	options: {
		cwd: "/tmp/steer-spike",
		model: "sonnet",
		settingSources: [],
		allowedTools: ["Bash"],
		includePartialMessages: true,
	},
});
send("A", plan.first);

let firedTool = false;
let firedText = false;
let results = 0;
const expectedResults = 2; // stop after 2 results, or idle timeout below
let idle = setTimeout(() => finish("idle-timeout"), 90_000);
function finish(why) {
	log(`=== END (${why}) results=${results}`);
	closed = true;
	wake?.();
	q.close();
	process.exit(0);
}

for await (const m of q) {
	clearTimeout(idle);
	idle = setTimeout(() => finish("idle 25s after last frame"), 25_000);
	const um = m.user_message_uuid ? ` umu=${name(m.user_message_uuid)}` : "";
	const ums = m.user_message_uuids
		? ` umus=[${m.user_message_uuids.map(name)}]`
		: "";
	if (m.type === "stream_event") {
		const e = m.event;
		if (e.type === "message_start")
			log(`stream message_start id=${e.message.id.slice(-8)}${um}${ums}`);
		if (
			!firedText &&
			e.type === "content_block_delta" &&
			e.delta?.type === "text_delta" &&
			plan.onFirstText
		) {
			firedText = true;
			setTimeout(() => plan.onFirstText(q), 800);
		}
		continue;
	}
	if (m.type === "assistant") {
		const blocks = m.message.content.map((b) =>
			b.type === "text"
				? `text:${short(b.text, 60)}`
				: b.type === "tool_use"
					? `tool_use:${b.name}`
					: b.type,
		);
		log(`assistant id=${m.message.id?.slice(-8)}${um}${ums} [${blocks}]`);
		if (
			!firedTool &&
			blocks.some((b) => b.startsWith("tool_use")) &&
			plan.onToolUse
		) {
			firedTool = true;
			setTimeout(() => plan.onToolUse(q), 2000);
		}
	} else if (m.type === "user") {
		const c = m.message.content;
		const desc =
			typeof c === "string"
				? `text:${short(c, 60)}`
				: c
						.map((b) =>
							b.type === "tool_result"
								? "tool_result"
								: `${b.type}:${short(b.text, 60)}`,
						)
						.join(",");
		log(
			`user uuid=${name(m.uuid)} replay=${m.isReplay ?? false} synthetic=${m.isSynthetic ?? false} prio=${m.priority ?? "-"} [${desc}]`,
		);
	} else if (m.type === "result") {
		results++;
		log(
			`RESULT ${m.subtype} turns=${m.num_turns}${um}${ums} text=${short(m.result, 80)}`,
		);
		if (results >= expectedResults) finish("got 2 results");
	} else if (m.type === "command_lifecycle") {
		const { type, command_uuid, state, uuid, session_id, ...rest } = m;
		log(
			`lifecycle ${name(command_uuid)} ${state} ${Object.keys(rest).length ? JSON.stringify(rest) : ""}`,
		);
	} else if (m.type === "system") {
		const extra =
			m.subtype === "init"
				? ` caps=${JSON.stringify(m.capabilities)}`
				: ` ${short(JSON.stringify(m), 160)}`;
		log(`system/${m.subtype}${extra}`);
	} else {
		log(
			`${m.type}${m.subtype ? "/" + m.subtype : ""} ${short(JSON.stringify(m), 160)}`,
		);
	}
}
finish("stream ended");
