import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
	return trimmed;
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
