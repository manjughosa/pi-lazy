import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteJson, getSettingsPath, isManagedLazy, loadConfig } from "./config.ts";
import { findSettingsPackageIndex, findSettingsPackageIndices } from "./resolve.ts";
import type { LazySpec } from "./types.ts";

export interface MigrateResult {
	ok: boolean;
	backupPath?: string;
	settingsPath: string;
	changed: string[];
	skipped: string[];
	added: string[];
	error?: string;
}

function packageSource(spec: LazySpec): string {
	if (
		spec.source.startsWith("npm:") ||
		spec.source.startsWith("git:") ||
		spec.source.startsWith("http://") ||
		spec.source.startsWith("https://") ||
		spec.source.startsWith("ssh://") ||
		spec.source.startsWith("/") ||
		spec.source.startsWith(".")
	) {
		return spec.source;
	}
	return `npm:${spec.source}`;
}

/**
 * The four resource types a Pi package can declare, and the only ones settings
 * can filter. All four are written together.
 *
 * Deferring a package's extension while leaving its skills, prompts and themes
 * live is not a deferral, it is half of one — and the leftover half is exactly
 * what surprises people: the package's tools are gone, but its skills are still
 * in the system prompt and its theme still overrides yours.
 *
 * Pi treats an absent key as "load everything the package declares" and `[]` as
 * "load none of that type", so writing all four is the only form that means
 * what `/lazy disable` says.
 */
const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

/** True when every resource key is present and empty — the form migrate writes. */
function isFullyDeferred(entry: Record<string, unknown>): boolean {
	return RESOURCE_KEYS.every((key) => Array.isArray(entry[key]) && (entry[key] as unknown[]).length === 0);
}

/** True when any resource key carries a `-`/`!` exclusion. */
function hasExclusions(entry: Record<string, unknown>): boolean {
	return RESOURCE_KEYS.some((key) => {
		const value = entry[key];
		return (
			Array.isArray(value) &&
			value.some((token) => typeof token === "string" && (token.trim().startsWith("-") || token.trim().startsWith("!")))
		);
	});
}

/**
 * Rewrite settings.packages so managed lazy specs keep the package installed but
 * load none of its resources.
 *
 * `extensions: []` is what defers the factory; the other three keys keep the
 * skills, prompts and themes out too. Pi only reads `settings.packages`, so this
 * file is the single place where a package's load behaviour is decided.
 */
export function migrateSettings(agentDir = getAgentDir()): MigrateResult {
	const settingsPath = getSettingsPath(agentDir);
	const config = loadConfig(agentDir);
	const managed = config.specs.filter(isManagedLazy);

	if (!existsSync(settingsPath)) {
		return { ok: false, settingsPath, changed: [], skipped: [], added: [], error: "settings.json not found" };
	}

	let settings: Record<string, unknown>;
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("settings.json root must be an object");
		}
		settings = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, settingsPath, changed: [], skipped: [], added: [], error: message };
	}

	const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
	const changed: string[] = [];
	const skipped: string[] = [];
	const added: string[] = [];
	for (const spec of config.specs) {
		const matches = findSettingsPackageIndices(packages, spec.source);
		if (matches.length > 1) {
			return {
				ok: false,
				settingsPath,
				changed,
				skipped,
				added,
				error: `duplicate settings.packages entries for ${spec.source} at indices ${matches.join(", ")}`,
			};
		}
	}

	for (const spec of managed) {
		const source = packageSource(spec);
		const idx = findSettingsPackageIndex(packages, spec.source);

		if (idx === -1) {
			// Guard 1: never fabricate an entry for a package not in settings.
			// Upstream pushed {source, extensions: []} here, which made /lazy
			// migrate a source of phantom packages (user's "15 → 20" packages).
			skipped.push(`${spec.name} (not registered; left alone)`);
			continue;
		}

		const current = packages[idx];
		if (typeof current === "string") {
			packages[idx] = { source: current, extensions: [], skills: [], prompts: [], themes: [] };
			changed.push(spec.name);
			continue;
		}

		if (current && typeof current === "object") {
			const entry = current as Record<string, unknown>;
			if (isFullyDeferred(entry)) {
				// Already in lazy form — leave untouched (also skips extmgr's
				// "all disabled" `[]`, which is ambiguous but already inert).
				skipped.push(spec.name);
				continue;
			}
			if (hasExclusions(entry)) {
				// Guard 2: entry carries exclusion markers → yield to extmgr / pi
				// config; never overwrite them with [].
				skipped.push(`${spec.name} (yielded: entry has exclusions)`);
				continue;
			}
			const obj = { ...entry };
			for (const key of RESOURCE_KEYS) obj[key] = [];
			if (typeof obj.source !== "string") obj.source = source;
			packages[idx] = obj;
			changed.push(spec.name);
			continue;
		}

		skipped.push(spec.name);
	}

	// Eager specs previously filtered empty → restore string form when safe.
	// `extensions: []` is the marker migrate itself wrote, so it gates the whole
	// strip: without that key we would be deleting filters the operator authored.
	for (const spec of config.specs.filter((s) => s.lazy === false)) {
		const idx = findSettingsPackageIndex(packages, spec.source);
		if (idx === -1) continue;
		const current = packages[idx];
		if (!current || typeof current !== "object") continue;

		const obj = current as Record<string, unknown>;
		if (!(Array.isArray(obj.extensions) && obj.extensions.length === 0 && typeof obj.source === "string")) {
			continue;
		}

		const restored = { ...obj };
		for (const key of RESOURCE_KEYS) {
			if (Array.isArray(restored[key]) && (restored[key] as unknown[]).length === 0) delete restored[key];
		}
		packages[idx] = Object.keys(restored).length === 1 ? restored.source : restored;
		changed.push(`${spec.name} (restored eager)`);
	}

	if (changed.length === 0) {
		return { ok: true, settingsPath, changed, skipped, added };
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = `${settingsPath}.bak.lazy-${stamp}`;
	try {
		copyFileSync(settingsPath, backupPath);
		settings.packages = packages;
		atomicWriteJson(settingsPath, settings);
		return { ok: true, backupPath, settingsPath, changed, skipped, added };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, backupPath, settingsPath, changed, skipped, added, error: message };
	}
}
