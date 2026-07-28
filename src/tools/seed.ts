// dforge_seed_add — write a seed-data file for one entity.
//
// Seed data has four documented traps, all of which fail the install rather
// than degrade gracefully:
//   • the PK key is `{entity}_id` with an explicit NUMERIC value (cuid is int8,
//     not a UUID) — records keyed on `id` silently insert nothing useful
//   • parents must load before children → the `NN-` filename prefix ordering
//   • an `audit-full` entity requires created_by / last_updated_by on EVERY
//     record; the System user is 0
//   • an FK value must correspond to a parent record that is itself seeded
//
// This tool enforces all four against the entity definition on disk.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandTraits } from "@dforge-core/metadata";
import {
	loadManifest,
	readJson,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	assertKnownTraits,
	type ToolResult,
} from "./_helpers";

/** The System user id — the only valid audit-full value for seeded rows. */
const SYSTEM_USER = 0;

export const seedAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entity: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Entity these records belong to."),
	records: z
		.array(z.record(z.string(), z.unknown()))
		.min(1)
		.describe(
			"The rows. Each MUST carry an explicit numeric PK under '{entity}_id' (cuid is int8, not a UUID). FK values must match a PK of an already-seeded parent.",
		),
	order: z
		.number()
		.int()
		.min(1)
		.max(99)
		.optional()
		.describe(
			"Load order — becomes the filename prefix (seed-data/NN-<entity>.json). Parents need a LOWER number than their children. Default: next free slot.",
		),
	fileName: z
		.string()
		.optional()
		.describe("Override the generated filename (without directory). Rarely needed."),
};

export function seedAdd(args: z.infer<z.ZodObject<typeof seedAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);

	const entityPath = path.join(paths.entitiesDir, `${args.entity}.json`);
	if (!fs.existsSync(entityPath)) {
		throw new Error(
			`Entity '${args.entity}' not found at entities/${args.entity}.json. ` +
				`Existing entities: ${Object.keys(manifest.entities ?? {}).join(", ") || "(none)"}.`,
		);
	}
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
	const traits = (entity.traits as string[] | undefined) ?? [];
	const pk = `${args.entity}_id`;
	const warnings: string[] = [];

	// ── PK: present, numeric, unique ──
	const seenPks = new Set<number>();
	args.records.forEach((r, i) => {
		if (!Object.prototype.hasOwnProperty.call(r, pk)) {
			const wrong = ["id", "ID", `${args.entity}Id`].find((k) =>
				Object.prototype.hasOwnProperty.call(r, k),
			);
			throw new Error(
				`Record ${i} has no '${pk}'${wrong ? ` (found '${wrong}' instead)` : ""}. ` +
					`Seed records need an explicit numeric PK under '{entity}_id' — the identity trait names it '${pk}', never 'id'.`,
			);
		}
		const v = r[pk];
		if (typeof v !== "number" || !Number.isInteger(v)) {
			throw new Error(
				`Record ${i}'s '${pk}' is ${JSON.stringify(v)} — it must be an INTEGER. ` +
					"The cuid type is int8, not a UUID or string.",
			);
		}
		if (seenPks.has(v)) throw new Error(`Duplicate '${pk}' value ${v} across the seed records.`);
		seenPks.add(v);
	});

	// ── audit-full requires who-columns on every record ──
	if (traits.includes("audit-full")) {
		const missing = args.records
			.map((r, i) => ({ i, r }))
			.filter(({ r }) => r.created_by === undefined || r.last_updated_by === undefined)
			.map(({ i }) => i);
		if (missing.length > 0) {
			throw new Error(
				`'${args.entity}' uses the 'audit-full' trait, whose created_by / last_updated_by columns are REQUIRED ` +
					`with no default — records [${missing.join(", ")}] set neither. Install fails with ` +
					`"required column 'created_by' … is not present in seed records". ` +
					`Set both to ${SYSTEM_USER} (the System user) on every record, switch the entity to the 'audit' trait, ` +
					"or don't seed it.",
			);
		}
	}

	// ── Unknown columns are almost always typos ──
	// Trait-provided columns are DERIVED from the registry, never hard-coded: the
	// canonical names are `created_date` / `last_updated` (audit), `order_num`
	// (sorting), `active` (soft-delete), etc. A hand-written list drifts from the
	// platform and then rejects legitimate seed columns as "unknown".
	assertKnownTraits(traits, args.entity);
	const traitFields = expandTraits(traits, args.entity) as Record<string, unknown>;
	const known = new Set([...Object.keys(fields), ...Object.keys(traitFields)]);
	known.add(pk);
	const unknown = new Set<string>();
	for (const r of args.records) {
		for (const k of Object.keys(r)) if (!known.has(k)) unknown.add(k);
	}
	if (unknown.size > 0) {
		const traitCols = Object.keys(traitFields);
		throw new Error(
			`Seed records set column(s) not defined on '${args.entity}': ${[...unknown].join(", ")}. ` +
				`Its columns are: ${Object.keys(fields).join(", ") || "(none authored)"}` +
				(traitCols.length > 0
					? `, plus these from traits [${traits.join(", ")}]: ${traitCols.join(", ")}.`
					: "."),
		);
	}

	// ── Reference columns are virtual: seed the hidden FK, not the R column ──
	for (const [fname, f] of Object.entries(fields)) {
		if (f?.columnType !== "R") continue;
		const used = args.records.some((r) => r[fname] !== undefined);
		if (used) {
			const thisKey = (f.link as Record<string, unknown> | undefined)?.thisKey;
			throw new Error(
				`'${fname}' is a Reference column (virtual — it owns no physical column), so it can't be seeded. ` +
					`Set the hidden FK '${String(thisKey ?? `${fname}_id`)}' to the parent's numeric PK instead.`,
			);
		}
	}

	// ── Required columns present on every record ──
	// A required column (flags contain M) with no formula default must be set.
	for (const [fname, f] of Object.entries(fields)) {
		const flags = typeof f?.flags === "string" ? f.flags : "";
		const isVirtual = f?.columnType === "R" || f?.columnType === "S" || f?.columnType === "F" || f?.columnType === "G";
		if (isVirtual || !flags.includes("M") || f?.formula !== undefined) continue;
		const missing = args.records.map((r, i) => (r[fname] === undefined ? i : -1)).filter((i) => i >= 0);
		if (missing.length > 0) {
			warnings.push(
				`required column '${fname}' is unset on record(s) [${missing.join(", ")}] — install may reject the row.`,
			);
		}
	}

	// ── FK values should point at a parent that is itself seeded ──
	const seedFiles = fs.existsSync(paths.seedDataDir)
		? fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json")).sort()
		: [];
	const seededPks: Record<string, Set<number>> = {};
	for (const f of seedFiles) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(paths.seedDataDir, f), "utf8"));
			const ec = data?.entityCode;
			if (typeof ec !== "string" || !Array.isArray(data.records)) continue;
			const set = seededPks[ec] ?? (seededPks[ec] = new Set());
			for (const r of data.records) {
				const v = r?.[`${ec}_id`];
				if (typeof v === "number") set.add(v);
			}
		} catch {
			/* unreadable seed file — the validator reports it */
		}
	}
	seededPks[args.entity] = seenPks;

	const refs = (entity.references as Record<string, Record<string, unknown>> | undefined) ?? {};
	for (const r of Object.values(refs)) {
		const fromField = (r?.from as Record<string, unknown> | undefined)?.field as string | undefined;
		const toEntity = (r?.to as Record<string, unknown> | undefined)?.entity as string | undefined;
		if (!fromField || !toEntity || toEntity.includes(".")) continue;
		const parentPks = seededPks[toEntity];
		for (const [i, rec] of args.records.entries()) {
			const v = rec[fromField];
			if (v === undefined || v === null) continue;
			if (typeof v !== "number") {
				warnings.push(`record ${i}: FK '${fromField}' is ${JSON.stringify(v)} — expected a numeric PK.`);
				continue;
			}
			if (!parentPks || !parentPks.has(v)) {
				warnings.push(
					`record ${i}: FK '${fromField}' = ${v}, but no seeded '${toEntity}' record has that PK — ` +
						`seed '${toEntity}' first (with a LOWER order prefix) or the install hits an FK violation.`,
				);
			}
		}
	}

	// ── Filename / load order ──
	let order = args.order;
	if (order === undefined) {
		// Reuse this entity's existing slot if it already has a seed file;
		// otherwise take the next free number.
		const mine = seedFiles.find((f) => f.replace(/^\d+-/, "") === `${args.entity}.json`);
		if (mine) {
			order = parseInt(mine.slice(0, 2), 10);
		} else {
			const used = seedFiles.map((f) => parseInt(f.slice(0, 2), 10)).filter((n) => !Number.isNaN(n));
			order = (used.length ? Math.max(...used) : 0) + 1;
		}
	}
	const fileName = args.fileName ?? `${String(order).padStart(2, "0")}-${args.entity}.json`;
	const seedPath = path.join(paths.seedDataDir, fileName);

	const payload = { entityCode: args.entity, records: args.records };

	return makeResult(
		`Seeded ${args.records.length} '${args.entity}' record(s) → seed-data/${fileName} (load order ${order}).`,
		{
			[rel(paths.root, seedPath)]: jsonText(payload),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		warnings.length > 0 ? `Seed warnings:\n${warnings.map((w) => `  • ${w}`).join("\n")}` : undefined,
	);
}
