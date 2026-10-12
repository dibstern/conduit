import { Data } from "effect";

export class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{
	readonly id: string;
	readonly message?: string;
}> {}

export const instanceNotFound = (id: string) =>
	new InstanceNotFound({
		id,
		message: `Instance "${id}" not found`,
	});
