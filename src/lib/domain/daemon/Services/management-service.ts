import { Context } from "effect";
import type {
	InstanceManagementDeps,
	ProjectManagementDeps,
} from "../../../handlers/types.js";

export class InstanceMgmtTag extends Context.Tag("InstanceMgmt")<
	InstanceMgmtTag,
	InstanceManagementDeps
>() {}

export class ProjectMgmtTag extends Context.Tag("ProjectMgmt")<
	ProjectMgmtTag,
	ProjectManagementDeps
>() {}
