// ui/reports.json checks: label, param declarations and record-report attachments.

import type { ValidateContext } from "./context";

/** Word for word the platform's (ReportLabels.Message), so the CLI's copy dedupes against it. */
export function unlabeledReportMessage(reportCd: string, description: unknown): string {
	const desc = typeof description === "string" && description.trim() !== "" ? description : undefined;
	return (
		`Report '${reportCd}' declares no "label", so its description names it` +
		(desc ? `: "${desc}".` : ".") +
		" Add a short label; the description then shows under it."
	);
}

// Reports: param declaration site + record-report attachments.
// Mirrors the server's ReportAttachmentValidator, which is the pack-time half
// of the check ReportRegistrar runs at install. Everything here is resolvable
// offline, and every failure mode is SILENT at runtime rather than loud.
export function checkReports(ctx: ValidateContext): void {
	const { manifest, err, warn, fieldDefsOf, deps, isKnownEntity, reports } = ctx;
	for (const [rcode, rawReport] of Object.entries(reports)) {
		const report = (rawReport ?? {}) as Record<string, unknown>;
		const where = `ui/reports.json → ${rcode}`;

		if (typeof report.label !== "string" || report.label.trim() === "") {
			warn("ui/reports.json", unlabeledReportMessage(rcode, report.description));
		}

		// Params are REPORT-scoped: the installer merges the report-level
		// `parameters` block with every dataset's `params` into one param_set,
		// report level winning on a code collision. Mirror that merge here so a
		// record-report mapping resolves against the same set install will build.
		const declaredParams = new Set<string>();

		const checkParamDef = (loc: string, pcode: string, pdef: unknown) => {
			const p = (pdef ?? {}) as Record<string, unknown>;
			if ("isRequired" in p) {
				err(
					`${where} → ${loc}.${pcode}`,
					"uses 'isRequired', which the installer does not read — the param installs as OPTIONAL. Rename it to 'required'.",
				);
			}
			if ("link" in p) {
				err(
					`${where} → ${loc}.${pcode}`,
					"puts 'link' at the top level, where the installer does not read it — a lookup param with no `params.link` has no autocomplete. Nest it: \"params\": { \"link\": { \"entity\": \"…\" } }.",
				);
			}
			if ("fieldTypeCd" in p && "domain" in p) {
				err(
					`${where} → ${loc}.${pcode}`,
					"declares both 'fieldTypeCd' and 'domain' — install rejects the pair rather than picking a winner. A domain supplies the control; drop the fieldTypeCd.",
				);
			}
		};

		const reportParams = (report.parameters as Record<string, unknown> | undefined) ?? {};
		for (const [pcode, pdef] of Object.entries(reportParams)) {
			declaredParams.add(pcode);
			checkParamDef("parameters", pcode, pdef);
		}

		const datasets = (report.datasets as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [dcode, ds] of Object.entries(datasets)) {
			const dsParams = (ds?.params as Record<string, Record<string, unknown>> | undefined) ?? {};
			for (const [pcode, pdef] of Object.entries(dsParams)) {
				declaredParams.add(pcode);
				checkParamDef(`datasets.${dcode}.params`, pcode, pdef);
			}
		}

		const attachments = report.entities;
		if (attachments === undefined) continue;
		if (!Array.isArray(attachments)) {
			err(where, "'entities' must be an array of record-report attachments.");
			continue;
		}

		const seen = new Set<string>();
		for (const raw of attachments) {
			const att = (raw ?? {}) as Record<string, unknown>;
			const entityCd = att.entityCd;
			if (typeof entityCd !== "string" || entityCd.trim() === "") {
				err(where, "an entry in 'entities' is missing 'entityCd'.");
				continue;
			}

			// Own-module prefix is redundant: 'crm.quote' inside crm is 'quote'.
			const bare =
				entityCd.startsWith(`${manifest.code}.`) ? entityCd.slice(manifest.code.length + 1) : entityCd;

			// UQ_Entity_Report is (entity_id, report_id): a second entry for the
			// same entity is not a second attachment, it overwrites the first's
			// param_map through the installer's ON CONFLICT upsert.
			if (seen.has(bare)) {
				err(
					where,
					`attaches to '${entityCd}' twice. One attachment per (entity, report) pair — merge the two 'params' maps into a single entry.`,
				);
				continue;
			}
			seen.add(bare);

			if (!isKnownEntity(entityCd)) {
				err(
					where,
					`attaches to '${entityCd}', which is not a known entity (same-module, system, or a declared cross-module dependency). Qualify a foreign entity as 'module.entity' and add that module to the manifest's dependencies.`,
				);
			}

			const paramMap = (att.params as Record<string, unknown> | undefined) ?? {};
			for (const [paramCd, source] of Object.entries(paramMap)) {
				if (!declaredParams.has(paramCd)) {
					err(
						where,
						`maps '${paramCd}' from '${entityCd}.${String(source)}', but '${paramCd}' is not a declared parameter of this report. Declare it in the report's 'parameters' block, or under the 'params' of the dataset that consumes it.`,
					);
					continue;
				}
				if (typeof source !== "string" || source.trim() === "") {
					err(where, `maps parameter '${paramCd}' from an empty source column on '${entityCd}'.`);
					continue;
				}
				// Column-level checks only where this module owns the entity —
				// a cross-module target's columns aren't visible offline, so those
				// fall through to install (same convention as FK targets in checkReferences).
				const fields = fieldDefsOf[bare];
				if (!fields) continue;
				const col = fields[source];
				if (!col) {
					err(
						where,
						`maps parameter '${paramCd}' from '${entityCd}.${source}', which is not a column of that entity.`,
					);
					continue;
				}
				if (col.columnType === "S" || col.columnType === "F") {
					err(
						where,
						`maps parameter '${paramCd}' from '${entityCd}.${source}', a ${col.columnType === "S" ? "set ('S')" : "formula ('F')"} column. Map the PK, a reference ('R') column, or a bounded scalar.`,
					);
					continue;
				}
				// Free text / json / binary are rejected by the installer's source
				// allowlist — a poor param source, and a runtime surprise if let through.
				const db = typeof col.dbDatatype === "string" ? col.dbDatatype.toLowerCase() : "";
				if (col.columnType !== "R" && col.isPk !== true && /^(text|json|jsonb|bytea|uuid)$/.test(db)) {
					err(
						where,
						`maps parameter '${paramCd}' from '${entityCd}.${source}' (dbDatatype '${db}'), which is not a valid record-report parameter source. Allowed: the entity PK, a reference column, or a bounded scalar (number, date/datetime, bool, dropdown/radio/flags code).`,
					);
				}
			}
		}

		if (seen.size > 0 && !deps.has("metadata")) {
			warn(
				where,
				"declares record-report attachments but the manifest has no 'metadata' dependency. The 'entity_report' table ships with the metadata system module — add \"metadata\": \">=1.5.0\" to dependencies so install fails loudly on a platform without it, rather than the attachment quietly doing nothing.",
			);
		}
	}
}
