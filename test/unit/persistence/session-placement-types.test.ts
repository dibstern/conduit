import { expect, it } from "vitest";
import {
	forkPlacement,
	type SessionCommand,
} from "../../../src/lib/domain/relay/Services/session-command.js";

type CreatedCommand = Extract<SessionCommand, { type: "session.created" }>;
const base = { sessionId: "session", title: "Session", provider: "claude" };
const acceptsCreated = (data: CreatedCommand["data"]): CreatedCommand => ({
	type: "session.created",
	data,
});

it("accepts plain sessions, subagents, Forks, Side Threads and forkPlacement", () => {
	const commands = [
		acceptsCreated(base),
		acceptsCreated({ ...base, parentId: "owner" }),
		acceptsCreated({ ...base, forkedFrom: "source" }),
		acceptsCreated({
			...base,
			parentId: "source",
			forkedFrom: "source",
			sideThread: true,
		}),
		acceptsCreated({ ...base, ...forkPlacement("source", false) }),
		acceptsCreated({ ...base, ...forkPlacement("source", true) }),
	];
	expect(commands).toHaveLength(6);
});

it("rejects mixed placements at the real session.created command seam", () => {
	// @ts-expect-error A Side Thread needs lineage as well as containment.
	acceptsCreated({ ...base, parentId: "source", sideThread: true });
	// @ts-expect-error A Side Thread needs containment as well as lineage.
	acceptsCreated({ ...base, forkedFrom: "source", sideThread: true });
	// @ts-expect-error Both relationships require an explicit Side Thread flag.
	acceptsCreated({ ...base, parentId: "source", forkedFrom: "source" });
	// @ts-expect-error A Side Thread cannot omit both relationships.
	acceptsCreated({ ...base, sideThread: true });
	// @ts-expect-error Containment plus lineage cannot describe a regular Fork.
	acceptsCreated({
		...base,
		parentId: "source",
		forkedFrom: "source",
		sideThread: false,
	});
});
