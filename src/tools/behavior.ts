// Three sibling tools for Phase 2 "behavior" registrations beyond plain
// actions: triggers (DB-event → action), scheduled jobs (cron → action),
// webhooks (DB-event → outbound HTTP). All three append to a `{<key>: [...]}`
// array wrapper in their respective JSON file — different from the
// keyed-by-code maps used by entities/views/roles.

import { z } from "zod";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	isValidCron,
	type ToolResult,
} from "./_helpers";

// ── trigger add ─────────────────────────────────────────────────────

export const triggerAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Trigger code, unique within the module."),
	entity: z
		.string()
		.describe(
			"Entity whose events fire this trigger. Cross-module dotted form supported ('fin.invoice').",
		),
	event: z
		.enum(["insert", "update", "delete", "status_change", "any"])
		.describe(
			"insert/update/delete are obvious. status_change fires only when status field changes value. 'any' fires for all insert/update/delete.",
		),
	action: z
		.string()
		.describe("Action code to invoke. Cross-module dotted form ('module.action') supported."),
	description: z.string().optional(),
	condition: z
		.string()
		.optional()
		.describe(
			"Optional formula expression (same shape as canExecute) using `[field]` syntax. Single-line boolean. If omitted, trigger fires on every matching event.",
		),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Static params merged into the action invocation alongside auto-injected record_id.",
		),
	async: z
		.boolean()
		.default(false)
		.describe(
			"When true, the action runs in background (recommended for slow actions). When false, runs in the same transaction — action failure rolls back the original DB change.",
		),
};

export function triggerAdd(args: z.infer<z.ZodObject<typeof triggerAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const file = readJsonOrDefault<{ triggers: Array<Record<string, unknown>> }>(
		paths.triggers,
		{ triggers: [] },
	);
	if (file.triggers.some((t) => t.code === args.code)) {
		throw new Error(`Trigger '${args.code}' already exists.`);
	}
	const entry: Record<string, unknown> = {
		code: args.code,
		entity: args.entity,
		event: args.event,
		action: args.action,
		async: args.async,
	};
	if (args.description) entry.description = args.description;
	if (args.condition) entry.condition = args.condition;
	if (args.params) entry.params = args.params;
	file.triggers.push(entry);

	return makeResult(
		`Added trigger '${args.code}' on ${args.entity}.${args.event} → action '${args.action}'${args.async ? " (async)" : ""}.`,
		{
			[rel(paths.root, paths.triggers)]: jsonText(file),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── job add ─────────────────────────────────────────────────────────

export const jobAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Job code, unique within the module."),
	action: z
		.string()
		.describe(
			"Action code to invoke on schedule. MUST NOT use record-context (`[field]`) syntax — scheduled jobs run as system user with no current record. Wrap record-context actions in a thin action that queries first.",
		),
	schedule: z
		.string()
		.describe(
			"5-field cron expression (minute hour day-of-month month day-of-week). Evaluated in the tenant's time zone (auth.tenant.time_zone) or per-job override.",
		),
	timeout: z
		.number()
		.int()
		.min(1)
		.max(3600)
		.describe(
			"Hard kill timeout in seconds. Required. If > 300, you must also set `class: 'long_running'`.",
		),
	description: z.string().optional(),
	concurrency: z
		.number()
		.int()
		.min(1)
		.default(1)
		.describe("Max overlapping executions. Default 1 (skip new fire if previous still running)."),
	jobClass: z
		.enum(["standard", "long_running"])
		.default("standard")
		.describe(
			"Required to be 'long_running' when timeout > 300. Affects scheduler thread-pool routing.",
		),
	paused: z.boolean().default(false),
};

export function jobAdd(args: z.infer<z.ZodObject<typeof jobAddSchema>>): ToolResult {
	if (!isValidCron(args.schedule)) {
		throw new Error(
			`Invalid cron expression '${args.schedule}'. Expected 5 fields: minute hour day-of-month month day-of-week (e.g. '0 2 * * 1').`,
		);
	}
	if (args.timeout > 300 && args.jobClass !== "long_running") {
		throw new Error(
			"Jobs with timeout > 300s must set jobClass: 'long_running' — see logic/jobs.json convention.",
		);
	}
	const { paths, manifest } = loadManifest(args.moduleDir);
	const file = readJsonOrDefault<{ jobs: Array<Record<string, unknown>> }>(
		paths.jobs,
		{ jobs: [] },
	);
	if (file.jobs.some((j) => j.code === args.code)) {
		throw new Error(`Job '${args.code}' already exists.`);
	}
	const entry: Record<string, unknown> = {
		code: args.code,
		action: args.action,
		schedule: args.schedule,
		timeout: args.timeout,
		concurrency: args.concurrency,
		class: args.jobClass,
	};
	if (args.description) entry.description = args.description;
	if (args.paused) entry.paused = true;
	file.jobs.push(entry);

	return makeResult(
		`Added job '${args.code}' (schedule '${args.schedule}', timeout ${args.timeout}s) → action '${args.action}'.`,
		{
			[rel(paths.root, paths.jobs)]: jsonText(file),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── webhook add ─────────────────────────────────────────────────────

export const webhookAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Subscription code, unique within the module."),
	entity: z.string().describe("Entity whose events fire this webhook."),
	event: z
		.enum(["insert", "update", "delete", "status_change", "any"])
		.describe("Same event taxonomy as triggers."),
	endpointUrl: z
		.string()
		.url()
		.describe("Destination URL — receives POST with the payload."),
	description: z.string().optional(),
	condition: z
		.string()
		.optional()
		.describe("Optional formula filter; fires only when true. Same shape as trigger condition."),
	payload: z
		.object({
			include: z
				.array(z.string())
				.optional()
				.describe("Whitelist of field codes to include. Omit to send all fields."),
			exclude: z
				.array(z.string())
				.optional()
				.describe("Blacklist (applied after include). Use for stripping sensitive cols."),
			includeOld: z
				.boolean()
				.optional()
				.describe(
					"For update/status_change events, also include the pre-change record as `old`.",
				),
		})
		.optional()
		.describe(
			"Payload shape. If omitted, sends full new record. The platform always wraps in `{ event, entity, record, old?, occurred_at }`.",
		),
	headers: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			"Extra HTTP headers (e.g. authentication tokens). Use `getSecret(...)` semantics: header values starting with `$secret:` are resolved at fire time.",
		),
};

export function webhookAdd(args: z.infer<z.ZodObject<typeof webhookAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const file = readJsonOrDefault<{ subscriptions: Array<Record<string, unknown>> }>(
		paths.webhooks,
		{ subscriptions: [] },
	);
	if (file.subscriptions.some((s) => s.code === args.code)) {
		throw new Error(`Webhook subscription '${args.code}' already exists.`);
	}
	const entry: Record<string, unknown> = {
		code: args.code,
		entity: args.entity,
		event: args.event,
		endpointUrl: args.endpointUrl,
	};
	if (args.description) entry.description = args.description;
	if (args.condition) entry.condition = args.condition;
	if (args.payload) entry.payload = args.payload;
	if (args.headers) entry.headers = args.headers;
	file.subscriptions.push(entry);

	return makeResult(
		`Added webhook subscription '${args.code}' on ${args.entity}.${args.event} → POST ${args.endpointUrl}.`,
		{
			[rel(paths.root, paths.webhooks)]: jsonText(file),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}
