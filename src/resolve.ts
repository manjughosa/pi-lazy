import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LazySpec } from "./types.ts";

interface PiManifest {
	extensions?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeIsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function npmPackageName(source: string): string | null {
	if (source.startsWith("npm:")) {
		const rest = source.slice(4);
		// strip version pins: npm:@scope/pkg@1.2.3 or npm:pkg@1.2.3
		if (rest.startsWith("@")) {
			const m = rest.match(/^(@[^/]+\/[^@]+)/);
			return m?.[1] ?? rest;
		}
		return rest.split("@")[0] ?? rest;
	}
	// bare npm name
	if (!source.includes(":") && !source.startsWith(".") && !source.startsWith("/")) {
		return source.startsWith("@") ? (source.match(/^(@[^/]+\/[^@]+)/)?.[1] ?? source) : source.split("@")[0]!;
	}
	return null;
}

function npmPackageIdentity(source: string): { name: string; selector?: string } | null {
	const name = npmPackageName(source);
	if (!name) return null;
	const rest = source.startsWith("npm:") ? source.slice(4) : source;
	const selector = rest.slice(name.length);
	return { name, ...(selector.startsWith("@") && selector.length > 1 ? { selector: selector.slice(1) } : {}) };
}

export function resolvePackageRoot(source: string, agentDir = getAgentDir(), cwd = process.cwd()): string | null {
	const npmName = npmPackageName(source);
	if (npmName) {
		const candidates = [
			join(agentDir, "npm", "node_modules", npmName),
			join(cwd, ".pi", "npm", "node_modules", npmName),
		];
		for (const c of candidates) {
			if (safeIsDirectory(c)) return c;
		}
		return null;
	}

	if (source.startsWith("git:") || source.startsWith("https://") || source.startsWith("http://") || source.startsWith("ssh://")) {
		// Best-effort: scan agent git dir for a package.json with matching name is hard; skip for v1 paths
		const gitRoot = join(agentDir, "git");
		if (existsSync(gitRoot)) {
			// leave unresolved unless local path form used
		}
		return null;
	}

	const local = resolve(cwd, source);
	if (safeIsDirectory(local)) return local;
	return null;
}

function readPiManifest(packageRoot: string): PiManifest | null {
	const pj = join(packageRoot, "package.json");
	if (!existsSync(pj)) return null;
	try {
		const pkg = JSON.parse(readFileSync(pj, "utf-8")) as unknown;
		if (!isRecord(pkg) || !isRecord(pkg.pi)) return null;
		const extensions = Array.isArray(pkg.pi.extensions)
			? pkg.pi.extensions.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
			: undefined;
		return { extensions };
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mts") || name.endsWith(".mjs");
}

/**
 * Resolve extension entry files for a package root (mirrors Pi loader rules).
 */
export function resolveExtensionEntries(packageRoot: string): string[] {
	const manifest = readPiManifest(packageRoot);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolved = resolve(packageRoot, extPath);
			const withinRoot = relative(packageRoot, resolved);
			if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) continue;
			if (!existsSync(resolved)) continue;
			let st;
			try {
				st = statSync(resolved);
			} catch {
				continue;
			}
			if (st.isFile() && isExtensionFile(resolved)) {
				entries.push(resolved);
				continue;
			}
			if (st.isDirectory()) {
				const indexTs = join(resolved, "index.ts");
				const indexJs = join(resolved, "index.js");
				if (existsSync(indexTs)) entries.push(indexTs);
				else if (existsSync(indexJs)) entries.push(indexJs);
				else {
					// directory of extension files (e.g. extensions/*.ts)
					try {
						for (const item of readdirSync(resolved, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
							if (item.isFile() && isExtensionFile(item.name)) {
								entries.push(join(resolved, item.name));
							}
						}
					} catch {
						/* ignore */
					}
				}
			}
		}
		if (entries.length > 0) return entries;
	}

	const indexTs = join(packageRoot, "index.ts");
	const indexJs = join(packageRoot, "index.js");
	if (existsSync(indexTs)) return [indexTs];
	if (existsSync(indexJs)) return [indexJs];
	return [];
}

export function resolveSpecPaths(spec: LazySpec, agentDir = getAgentDir(), cwd = process.cwd()) {
	const packageRoot = resolvePackageRoot(spec.source, agentDir, cwd);
	if (!packageRoot) {
		return { packageRoot: null as string | null, extensionPaths: [] as string[] };
	}
	return {
		packageRoot,
		extensionPaths: resolveExtensionEntries(packageRoot),
	};
}

/** Detect whether settings has this package with extensions filtered to none. */
export function isModuleLazyInSettings(source: string, settingsPackages: unknown[]): boolean {
	const matches: unknown[] = [];
	for (const entry of settingsPackages) {
		if (typeof entry === "string") {
			if (sourcesMatch(entry, source)) matches.push(entry);
			continue;
		}
		if (entry && typeof entry === "object") {
			const obj = entry as { source?: string; extensions?: unknown };
			if (typeof obj.source === "string" && sourcesMatch(obj.source, source)) matches.push(entry);
		}
	}
	if (matches.length !== 1) return false;
	const match = matches[0];
	return (
		!!match
		&& typeof match === "object"
		&& Array.isArray((match as { extensions?: unknown }).extensions)
		&& (match as { extensions: unknown[] }).extensions.length === 0
	);
}

export function normalizeSourceKey(source: string): string {
	const trimmed = source.trim();
	const npm = npmPackageName(trimmed);
	if (npm) return `npm:${trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed}`;
	// P14: resolve local paths through junctions/symlinks so two spellings of the
	// same directory (E:\pi-agent\agent\... vs C:\Users\...\.pi\agent\...) share one
	// dedup key instead of becoming two specs / two roster entries.
	try {
		return realpathSync(trimmed).replace(/[\\\/]+$/, "").toLowerCase();
	} catch {
		return trimmed.replace(/[\\\/]+$/, "").toLowerCase();
	}
}

export function sourcesMatch(left: string, right: string): boolean {
	const leftNpm = npmPackageIdentity(left);
	const rightNpm = npmPackageIdentity(right);
	if (leftNpm || rightNpm) {
		if (!leftNpm || !rightNpm || leftNpm.name !== rightNpm.name) return false;
		return !leftNpm.selector || !rightNpm.selector || leftNpm.selector === rightNpm.selector;
	}
	return normalizeSourceKey(left) === normalizeSourceKey(right);
}

export function findSettingsPackageIndex(settingsPackages: unknown[], source: string): number {
	return findSettingsPackageIndices(settingsPackages, source)[0] ?? -1;
}

/**
 * Specs for every package pi is configured to load that no existing spec covers.
 *
 * Scope is deliberately limited to `settings.json`'s `packages` array — the
 * authoritative list of what pi actually loads. Packages merely present in
 * node_modules are NOT returned: lazy never activates a package pi has not
 * registered, so a spec for one would be inert and would confuse `/lazy status`.
 * This mirrors migrate's Guard 1 (never fabricate settings entries).
 *
 * A package is skipped when it cannot be given a meaningful default: a bare
 * `"extensions": ["+..."]` entry is an explicit opt-in to one entrypoint, and
 * inferring lazy's own `cmd`/`keywords` for an unknown extension would be guesswork.
 * Those keep their current behaviour until the operator writes a spec by hand.
 */
export function discoverSpecsFromSettings(settingsPackages: unknown[], existing: LazySpec[]): LazySpec[] {
	const covered = new Set(existing.map((spec) => normalizeSourceKey(spec.source)));
	const discovered: LazySpec[] = [];
	const seen = new Set<string>();

	settingsPackages.forEach((entry) => {
		let source: string;
		let extensionFilter: unknown;

		if (typeof entry === "string") {
			source = entry;
		} else if (entry && typeof entry === "object" && typeof (entry as { source?: string }).source === "string") {
			source = (entry as { source: string }).source;
			extensionFilter = (entry as { extensions?: unknown }).extensions;
		} else {
			return;
		}

		const key = normalizeSourceKey(source);
		if (covered.has(key) || seen.has(key)) return;
		seen.add(key);

		// Entries that select specific entrypoints are left to the operator.
		if (Array.isArray(extensionFilter) && extensionFilter.length > 0) return;

		discovered.push({
			name: specNameFromSource(source),
			source,
			lazy: false,
			keywords: [specNameFromSource(source)],
			description: "auto-discovered from settings.json — stays eager; set lazy/after-start by hand to defer it",
		});
	});

	return discovered;
}

/**
 * Local extensions living in `<agent-dir>/extensions/<name>/`.
 *
 * These are not packages: Pi discovers them by walking that directory and loads
 * whatever each folder's manifest declares, so no `settings.packages` entry
 * exists and none of the `packages[].extensions` filters apply to them. That makes
 * them permanently eager as far as this extension is concerned — a spec for one
 * would be inert.
 *
 * Registering one as a package is the only way to bring it under lazy control:
 * a package entry carries its own `extensions` filter, which is what actually
 * defers the factory. So each discovered directory is returned as a spec *and* as
 * the settings entry that gives it a filter, and the caller adds both.
 *
 * Folders without a usable manifest are skipped rather than guessed at: a bare
 * directory with no `pi.extensions` and no index file contributes nothing, and
 * adding a spec for it would produce an entry that fails to load forever.
 */
export function discoverLocalExtensions(agentDir: string, existing: LazySpec[]): Array<{ spec: LazySpec; settingsEntry: { source: string; extensions: string[] } }> {
	const extensionsDir = join(agentDir, "extensions");
	if (!existsSync(extensionsDir)) return [];

	const covered = new Set(existing.map((spec) => normalizeSourceKey(spec.source)));
	const found: Array<{ spec: LazySpec; settingsEntry: { source: string; extensions: string[] } }> = [];

	let entries: Array<{ name: string; isDirectory: boolean }>;
	try {
		entries = readdirSync(extensionsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => ({ name: e.name, isDirectory: true }));
	} catch {
		return [];
	}

	for (const entry of entries) {
		const dir = join(extensionsDir, entry.name);
		const manifestPath = join(dir, "package.json");
		if (!existsSync(manifestPath)) continue;

		let declared: string[] = [];
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: string; pi?: { extensions?: unknown } };
			const list = manifest.pi?.extensions;
			if (!Array.isArray(list)) continue;
			declared = list.filter((v): v is string => typeof v === "string");
		} catch {
			continue;
		}
		if (declared.length === 0) continue;

		// Keep only declarations that resolve to real files inside the package.
		const usable = declared.filter((rel) => {
			const resolved = resolve(dir, rel);
			if (!existsSync(resolved)) return false;
			try {
				return statSync(resolved).isFile();
			} catch {
				return false;
			}
		});
		if (usable.length === 0) continue;

		const source = dir;
		if (covered.has(normalizeSourceKey(source))) continue;

		const name = specNameFromSource(source);
		found.push({
			spec: {
				name,
				source,
				lazy: false,
				keywords: [name],
				description: "local extension under extensions/ — stays eager; set lazy/after-start by hand to defer it",
			},
			// Register it as a package so the entrypoint is pinned explicitly, but keep the
			// package eager. The extension was already being loaded by the extensions/
			// walk before this entry existed; registering it must not silently change when
			// that happens, so the default is the status quo and deferral is opt-in.
			settingsEntry: { source, extensions: usable.map((rel) => `+${rel.replace(/\\/g, "/")}`) },
		});
	}

	return found;
}

/** Derive a readable spec name from a package source (npm:pkg, path, git URL). */
function specNameFromSource(source: string): string {
	const bare = source.startsWith("npm:") ? source.slice(4) : source;
	const name = npmPackageName(source);
	if (name) return name;
	const normalized = bare.replace(/\\/g, "/").replace(/\/+$/, "");
	const segments = normalized.split("/").filter(Boolean);
	return segments[segments.length - 1] ?? bare;
}

export function findSettingsPackageIndices(settingsPackages: unknown[], source: string): number[] {
	const indices: number[] = [];
	settingsPackages.forEach((entry, index) => {
		if (typeof entry === "string") {
			if (sourcesMatch(entry, source)) indices.push(index);
			return;
		}
		if (entry && typeof entry === "object" && typeof (entry as { source?: string }).source === "string") {
			if (sourcesMatch((entry as { source: string }).source, source)) indices.push(index);
			return;
		}
	});
	return indices;
}
