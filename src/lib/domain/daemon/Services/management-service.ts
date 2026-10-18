import { Context } from "effect";
import type {
	InstanceManagementDeps,
	ProjectManagementDeps,
} from "../../../handlers/types.js";

export class InstanceMgmtTag extends Context.Service<
	InstanceMgmtTag,
	InstanceManagementDeps
>()("InstanceMgmt") {}

export class ProjectMgmtTag extends Context.Service<
	ProjectMgmtTag,
	ProjectManagementDeps
>()("ProjectMgmt") {}
