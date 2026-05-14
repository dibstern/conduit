import { Data } from "effect";

export class InstanceLimitExceeded extends Data.TaggedError(
	"InstanceLimitExceeded",
)<{
	readonly max: number;
	readonly message?: string;
}> {}

export class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{
	readonly id: string;
	readonly message?: string;
}> {}

export class InstanceAlreadyExists extends Data.TaggedError(
	"InstanceAlreadyExists",
)<{
	readonly id: string;
	readonly message?: string;
}> {}

export class InvalidInstanceUrl extends Data.TaggedError("InvalidInstanceUrl")<{
	readonly id: string;
	readonly url: string;
	readonly cause?: unknown;
	readonly message?: string;
}> {}

export class CannotStartExternalInstance extends Data.TaggedError(
	"CannotStartExternalInstance",
)<{
	readonly id: string;
	readonly message?: string;
}> {}

export const instanceAlreadyExists = (id: string) =>
	new InstanceAlreadyExists({
		id,
		message: `Instance "${id}" already exists`,
	});

export const instanceLimitExceeded = (max: number) =>
	new InstanceLimitExceeded({
		max,
		message: `Max instances reached (${max}). Remove an instance first.`,
	});

export const invalidInstanceUrl = (id: string, url: string, cause?: unknown) =>
	new InvalidInstanceUrl({
		id,
		url,
		cause,
		message: `Invalid URL for instance "${id}": ${url}`,
	});

export const instanceNotFound = (id: string) =>
	new InstanceNotFound({
		id,
		message: `Instance "${id}" not found`,
	});

export const cannotStartExternalInstance = (id: string) =>
	new CannotStartExternalInstance({
		id,
		message: "Cannot start external instance",
	});
