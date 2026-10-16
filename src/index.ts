/**
 * pi-lazy — LazyVim-style extension manager for Pi Coding Agent.
 *
 * Load strategies:
 *   lazy: false         always-on (Pi loads normally)
 *   lazy: "after-start" VeryLazy — load after session_start
 *   lazy: true          on demand via cmd / tools / events / keywords / /lazy load
 *
 * True module-lazy requires `/lazy migrate` once (sets packages[].extensions = []).
 */

import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_AFTER_START_INITIAL_DELAY_MS,
	atomicWriteJson,
	defaultConfig,
	getLazyConfigPath,
	isManagedLazy,
	loadConfig,
	saveConfig,
} from "./config.ts";
import { loadResolvedEntry, prefetchEntry } from "./loader.ts";
import { migrateSettings } from "./migrate.ts";
import { isModuleLazyInSettings, resolveSpecPaths, sourcesMatch, findSettingsPackageIndices, discoverSpecsFromSettings, discoverLocalExtensions, normalizeSourceKey, npmPackageName } from "./resolve.ts";
import { performance } from "node:perf_hooks";
import type { LazyConfig, LazySpec, LoadResult, ResolvedEntry } from "./types.ts";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getSettingsPath } from "./config.ts";

interface Runtime {
	config: LazyConfig;
	entries: Map<string, ResolvedEntry>;
	auto: boolean;
	sessionCtx?: ExtensionContext;
	afterStartQueued: boolean;
	status: string;
	profile: Array<{ label: string; ms: number }>;
	queueCancelled: boolean;
	sessionGeneration: number;
	restartRequired: boolean;
	/** True between before_agent_start and agent_end/agent_settled. */
	turnActive: boolean;
	/** Resolvers for after-start slices parked until the current turn finishes. */
	resumeWaiters: Array<() => void>;
}

/** Upper bound on one adaptive yield, so a slow package cannot stall the queue. */
const MAX_ADAPTIVE_YIELD_MS = 250;

/** Failsafe in case the host never emits a turn-end event for a started turn. */
const PAUSE_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

function drainResumeWaiters(rt: Runtime) {
	const waiters = rt.resumeWaiters;
	rt.resumeWaiters = [];
	for (const resolve of waiters) resolve();
}

/**
 * Park the after-start queue while the agent is working.
 *
 * Activating a package is mostly synchronous CPU, so a slice that runs during a
 * turn stalls streaming output and keystroke handling. Waiting costs nothing —
 * these packages are deferred by definition.
 */
function waitWhilePaused(rt: Runtime, generation: number): Promise<void> {
	if (!rt.turnActive) return Promise.resolve();
	if (rt.queueCancelled || generation !== rt.sessionGeneration) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, PAUSE_TIMEOUT_MS);
		timer.unref?.();
		rt.resumeWaiters.push(finish);
	});
}

function readSettingsPackages(agentDir: string): unknown[] {
	const path = getSettingsPath(agentDir);
	if (!existsSync(path)) return [];
	try {
		const settings = JSON.parse(readFileSync(path, "utf-8")) as { packages?: unknown[] };
		return Array.isArray(settings.packages) ? settings.packages : [];
	} catch {
		return [];
	}
}

function buildCatalog(config: LazyConfig, agentDir: string): Map<string, ResolvedEntry> {
	const packages = readSettingsPackages(agentDir);
	const map = new Map<string, ResolvedEntry>();

	for (const spec of config.specs) {
		const managed = isManagedLazy(spec);
		const moduleLazyReady = managed && isModuleLazyInSettings(spec.source, packages);

		let state: ResolvedEntry["state"];
		if (!managed) {
			state = "eager";
		} else if (!moduleLazyReady) {
			// Still eager in settings — Pi already loaded (or will load) the factory
			state = "eager";
		} else {
			state = "pending";
		}

		map.set(spec.name, {
			spec,
			// Avoid filesystem/package.json scans for packages that are never loaded.
			packageRoot: "",
			extensionPaths: [],
			moduleLazyReady,
			state,
			normalizedKeywords: (spec.keywords ?? []).map((keyword) => keyword.toLowerCase()),
		});
	}

	return map;
}

function formatStatus(rt: Runtime): string {
	const all = [...rt.entries.values()];
	const loaded = all.filter((e) => e.state === "loaded").length;
	const pending = all.filter((e) => e.state === "pending").length;
	const eager = all.filter((e) => e.state === "eager").length;
	const errors = all.filter((e) => e.state === "error" || e.state === "poisoned").length;
	const parts = [`lazy ${loaded}↑`, `${pending}·`, `${eager}⚡`];
	if (errors) parts.push(`${errors}✗`);
	if (rt.restartRequired) parts.push("restart required");
	return parts.join(" ");
}

function scanIntoConfig(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionContext, agentDir: string): string[] {
	const currentPath = getLazyConfigPath(agentDir);
	const hadExisting = existsSync(currentPath);
	const existingConfig = hadExisting ? loadConfig(agentDir) : defaultConfig();
	const before = existingConfig.specs.length;

	const settingsPath = getSettingsPath(agentDir);
	let packages: unknown[] = [];
	let settingsWarning = "";
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
			packages =
				parsed && typeof parsed === "object" && Array.isArray((parsed as { packages?: unknown }).packages)
					? ((parsed as { packages: unknown[] }).packages as unknown[])
					: [];
		} catch (err) {
			settingsWarning = `settings.json could not be read: ${err instanceof Error ? err.message : String(err)}`;
		}
	} else {
		settingsWarning = "settings.json not found — no packages could be scanned.";
	}

	const discovered = discoverSpecsFromSettings(packages, existingConfig.specs);

	// Local extensions under extensions/ are not packages: Pi discovers them by
	// walking that directory, so no settings entry exists and no package filter
	// applies. They are permanently eager unless registered as a package, which is
	// what gives them a filter migrate can rewrite. Both halves are written here.
	const localExts = discoverLocalExtensions(agentDir, [...existingConfig.specs, ...discovered]);
	const localSettingsAdded = localExts.filter(
		(e) => !packages.some((p) => (typeof p === "string" ? p : (p as { source?: unknown })?.source) === e.settingsEntry.source),
	);

	const next: LazyConfig = { ...existingConfig, specs: [...existingConfig.specs, ...discovered, ...localExts.map((e) => e.spec)] };

	let backup = "";
	if (hadExisting) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		backup = `${currentPath}.bak.init-${stamp}`;
		copyFileSync(currentPath, backup);
	}

	if (localSettingsAdded.length > 0 && existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.packages)) {
				parsed.packages = [...(parsed.packages as unknown[]), ...localSettingsAdded.map((e) => e.settingsEntry)];
				atomicWriteJson(settingsPath, parsed);
			}
		} catch (err) {
			settingsWarning = `settings.json could not be updated with local extensions: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	const path = saveConfig(next, agentDir);
	rt.restartRequired = true;
	rt.config = next;
	refreshStatus(pi, rt, ctx);

	const lines: string[] = [];
	if (!hadExisting) {
		lines.push(`no lazy.json found — created ${path} with default specs (${before}).`);
	} else {
		lines.push(`kept ${before} existing spec${before === 1 ? "" : "s"} → ${path}${backup ? `\nbackup: ${backup}` : ""}`);
	}

	if (discovered.length === 0) {
		lines.push("no new packages to add — config already covers settings.json.");
	} else {
		lines.push(`added ${discovered.length} discovered package${discovered.length === 1 ? "" : "s"}:`);
		for (const spec of discovered) lines.push(`  + ${spec.name}`);
		lines.push("left eager (lazy:false) — set lazy:true or after-start by hand to defer them.");
	}
	if (localExts.length > 0) {
		lines.push(`added ${localExts.length} local extension${localExts.length === 1 ? "" : "s"} from extensions/:`);
		for (const e of localExts) lines.push(`  + ${e.spec.name}  →  ${e.settingsEntry.extensions.join(", ")}`);
		lines.push("left eager (lazy:false) — set lazy:true or after-start by hand to defer them.");
	}
	if (settingsWarning) lines.push(settingsWarning);
	return lines;
}

/** Directory holding saved plugin snapshots. */
function snapshotDir(agentDir: string): string {
	return join(agentDir, "lazy-snapshots");
}

/** snapshot names are used as filenames, so restrict them to a safe subset. */
function snapshotPathFor(agentDir: string, name: string): string | null {
	const trimmed = name.trim();
	if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/:*?"<>|]/.test(trimmed)) return null;
	return join(snapshotDir(agentDir), `${trimmed}.json`);
}

/**
 * Snapshot the whole loading scheme to a named snapshot file.
 *
 * A snapshot is NOT just the catalog. `lazy.json` alone cannot reproduce a scheme:
 * the `packages` array in settings.json is what pi actually registers, and the
 * `extensions` filter form there (`[]` = module-lazy, `["+index.ts"]` = force a
 * single entrypoint, absent = eager) decides eager-vs-lazy semantics that no
 * amount of spec editing can reproduce. Saving only specs produced snapshots that
 * loaded nothing on restore, because scan can only ever discover packages that
 * settings already lists.
 *
 * So both halves are captured: `config` (the catalog + global switches) and
 * `settings.packages` (the registration with each entry's filter form intact).
 *
 * Overwriting an existing snapshot keeps the previous file under `.bak-<stamp>`:
 * silently losing one is how a snapshot system becomes a source of drift.
 */
function snapshotSave(agentDir: string, name: string): { ok: boolean; path: string; specCount: number; packageCount: number; overwrote: boolean; previous?: string; error?: string } {
	const path = snapshotPathFor(agentDir, name);
	const fail = (error: string) => ({ ok: false, path: path ?? "", specCount: 0, packageCount: 0, overwrote: false, error });
	if (!path) return fail(`invalid snapshot name "${name}" (avoid / \\ : * ? " < > | )`);

	const config = loadConfig(agentDir);
	let packages: unknown[] | null = null;
	const settingsPath = getSettingsPath(agentDir);
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: unknown };
			packages = Array.isArray(parsed?.packages) ? parsed.packages : [];
		} catch (err) {
			return fail(`settings.json unreadable, cannot capture packages: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		return fail("settings.json not found — cannot capture a loading scheme without it");
	}

	try {
		mkdirSync(snapshotDir(agentDir), { recursive: true });
		let previous: string | undefined;
		if (existsSync(path)) {
			previous = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			copyFileSync(path, previous);
		}
		atomicWriteJson(path, {
			name: name.trim(),
			savedAt: new Date().toISOString(),
			version: 2,
			config,
			settings: { packages },
		});
		return { ok: true, path, specCount: config.specs.length, packageCount: packages.length, overwrote: previous !== undefined, previous };
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}

interface SnapshotRestoreResult {
	ok: boolean;
	specCount: number;
	packageCount: number;
	added: string[];
	removed: string[];
	migrated: number;
	backups: string[];
	error?: string;
}

/**
 * Replace the loading scheme with a saved snapshot — a swap, not a merge.
 *
 * Restoring 5678 over a live 1234 must yield exactly 5678, so all three halves
 * are written:
 *   1. settings.packages ← the snapshot's captured list (this is what removes 1234
 *      from registration and adds 5678; a catalog-only write leaves 1234 loaded)
 *   2. lazy.json        ← the snapshot's catalog
 *   3. migrateSettings  ← turns the snapshot's `lazy` modes into `extensions: []`,
 *      which is the only step that actually defers a package's factory
 *
 * Packages the snapshot does not mention are reported in `removed` rather than
 * deleted from disk: node_modules is never touched, so switching schemes is
 * reversible with one `pi install`.
 *
 * Both files are backed up first; this is a replacement and it is undoable via
 * `/lazy restore` or by loading the previous snapshot again.
 */
function snapshotRestore(agentDir: string, name: string): SnapshotRestoreResult {
	const path = snapshotPathFor(agentDir, name);
	const empty: SnapshotRestoreResult = { ok: false, specCount: 0, packageCount: 0, added: [], removed: [], migrated: 0, backups: [] };
	if (!path || !existsSync(path)) return { ...empty, error: `no saved snapshot named "${name}"` };

	let snapshot: { config?: LazyConfig; settings?: { packages?: unknown } };
	try {
		snapshot = JSON.parse(readFileSync(path, "utf-8")) as { config?: LazyConfig; settings?: { packages?: unknown } };
	} catch (err) {
		return { ...empty, error: `snapshot unreadable: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!snapshot.config || !Array.isArray(snapshot.config.specs)) {
		return { ...empty, error: "snapshot has no spec list — was it written by an older version?" };
	}
	if (!Array.isArray(snapshot.settings?.packages)) {
		return { ...empty, error: "snapshot carries no settings.packages — save it again with this version (a spec-only snapshot cannot register its packages)" };
	}

	const current = loadConfig(agentDir);
	const settingsPath = getSettingsPath(agentDir);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backups: string[] = [];

	const currentPackages = ((): unknown[] => {
		if (!existsSync(settingsPath)) return [];
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: unknown };
			return Array.isArray(parsed?.packages) ? parsed.packages : [];
		} catch {
			return [];
		}
	})();

	const sourceOf = (entry: unknown): string | null => {
		const s = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
		return typeof s === "string" ? s : null;
	};
	const nextSources = new Set(snapshot.settings.packages.map(sourceOf).filter((s): s is string => s !== null));
	const removed = currentPackages
		.map(sourceOf)
		.filter((s): s is string => s !== null && !nextSources.has(s));
	const currentNames = new Set(current.specs.map((s) => s.name));
	const added = snapshot.config.specs.map((s) => s.name).filter((n) => !currentNames.has(n));

	try {
		if (existsSync(getLazyConfigPath(agentDir))) {
			const b = `${getLazyConfigPath(agentDir)}.bak.snapshot-${stamp}`;
			copyFileSync(getLazyConfigPath(agentDir), b);
			backups.push(b);
		}
		if (existsSync(settingsPath)) {
			const b = `${settingsPath}.bak.snapshot-${stamp}`;
			copyFileSync(settingsPath, b);
			backups.push(b);
		}

		// 1. registration — this is what swaps 1234 out for 5678.
		let settings: Record<string, unknown> | null = null;
		if (existsSync(settingsPath)) {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
		}
		if (settings) {
			settings.packages = snapshot.settings.packages;
			atomicWriteJson(settingsPath, settings);
		}

		// 2. catalog
		saveConfig(snapshot.config, agentDir);

		// 3. land the modes — without this the specs exist but nothing defers.
		const migration = migrateSettings(agentDir);
		return {
			ok: migration.ok,
			specCount: snapshot.config.specs.length,
			packageCount: snapshot.settings.packages.length,
			added,
			removed,
			migrated: migration.changed.length,
			backups,
			...(migration.ok ? {} : { error: `migrate failed: ${migration.error}` }),
		};
	} catch (err) {
		return { ...empty, backups, error: err instanceof Error ? err.message : String(err) };
	}
}

function snapshotDelete(agentDir: string, name: string): { ok: boolean; error?: string } {
	const path = snapshotPathFor(agentDir, name);
	if (!path || !existsSync(path)) return { ok: false, error: `no saved snapshot named "${name}"` };
	try {
		unlinkSync(path);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function snapshotList(agentDir: string): Array<{ name: string; specCount: number; packageCount: number; savedAt: string }> {
	const dir = snapshotDir(agentDir);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json") && !f.includes(".bak-"))
			.map((f) => {
				try {
					const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { savedAt?: string; config?: { specs?: unknown[] }; settings?: { packages?: unknown[] } };
					return {
						name: f.replace(/\.json$/, ""),
						specCount: parsed.config?.specs?.length ?? 0,
						packageCount: parsed.settings?.packages?.length ?? 0,
						savedAt: parsed.savedAt ?? "unknown",
					};
				} catch {
					return { name: f.replace(/\.json$/, ""), specCount: 0, packageCount: 0, savedAt: "unreadable" };
				}
			})
			.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
	} catch {
		return [];
	}
}

/**
 * Propagate the live loading scheme into every saved snapshot.
 *
 * A snapshot replaces `settings.packages` wholesale, so a package added after the
 * snapshot was taken is simply absent from it. Restoring that snapshot then
 * deregisters the package: it stops loading, with no error anywhere. `/lazy init`
 * is where packages appear, so it is where this is repaired.
 *
 * Additive only. Existing entries keep their own filter form — that form is the
 * whole reason the snapshot exists. Runs after migrate, so the package lands in
 * the same resolved shape it has live.
 */
function mergeLiveIntoSnapshots(agentDir: string): { updated: string[]; added: number; error?: string } {
	const dir = snapshotDir(agentDir);
	if (!existsSync(dir)) return { updated: [], added: 0 };

	const liveSpecs = loadConfig(agentDir).specs;
	let livePackages: unknown[] = [];
	try {
		const parsed = JSON.parse(readFileSync(getSettingsPath(agentDir), "utf-8")) as { packages?: unknown };
		if (Array.isArray(parsed?.packages)) livePackages = parsed.packages;
	} catch (err) {
		return { updated: [], added: 0, error: `settings.json unreadable, snapshots left alone: ${err instanceof Error ? err.message : String(err)}` };
	}

	const sourceOf = (e: unknown): string | null => {
		const s = typeof e === "string" ? e : (e as { source?: unknown })?.source;
		return typeof s === "string" ? s : null;
	};

	const updated: string[] = [];
	let added = 0;
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".bak-"))) {
		const path = join(dir, file);
		let snap: { config?: LazyConfig; settings?: { packages?: unknown[] } };
		try {
			snap = JSON.parse(readFileSync(path, "utf-8")) as typeof snap;
		} catch {
			continue;
		}
		if (!snap.config || !Array.isArray(snap.config.specs)) continue;
		if (!Array.isArray(snap.settings?.packages)) continue;

		const savedSpecs = snap.config.specs;
		const savedPackages = snap.settings.packages;
		const missingSpecs = liveSpecs.filter((s) => !savedSpecs.some((k) => k.name === s.name || sourcesMatch(k.source, s.source)));
		const knownSources = savedPackages.map(sourceOf).filter((s): s is string => s !== null);
		const missingPackages = livePackages.filter((e) => {
			const s = sourceOf(e);
			return s !== null && !knownSources.some((k) => sourcesMatch(k, s));
		});
		if (missingSpecs.length === 0 && missingPackages.length === 0) continue;

		snap.config.specs = [...savedSpecs, ...missingSpecs];
		snap.settings.packages = [...savedPackages, ...missingPackages];
		atomicWriteJson(path, snap);
		updated.push(`${file.replace(/\.json$/, "")} (+${missingSpecs.length} spec, +${missingPackages.length} pkg)`);
		added += missingSpecs.length + missingPackages.length;
	}
	return { updated, added };
}

interface EnableResult {
	ok: boolean;
	restoredSpec?: boolean;
	restoredEntry?: boolean;
	noop?: boolean;
	mode?: string;
	specFrom?: string;
	entryFrom?: string;
	migrated?: number;
	migrateSkipped?: number;
	migrateError?: string;
	backups: string[];
	error?: string;
}

interface DisableResult {
	ok: boolean;
	noop?: boolean;
	droppedFromSettings: boolean;
	migrated?: number;
	migrateSkipped?: number;
	backups: string[];
	error?: string;
}

/**
 * Disable a package: drop it from the lazy catalog and from settings.packages.
 *
 * Named "disable" rather than remove/uninstall on purpose. `extensions: []` in
 * settings.json does NOT uninstall anything — package-manager.js defaults every
 * entry to `enabled = true` and applies `+`/`-` overrides on top, so an empty list
 * simply yields no enabled files. The npm package stays in node_modules either
 * way. This command therefore removes the package from the *loading scheme*
 * (catalog spec + settings registration); it never touches node_modules, and
 * `pi install npm:<name>` brings it back with one command.
 *
 * That is deliberately not a fourth `lazy` mode. The three modes decide *when* a
 * catalog member loads; disabling decides whether it is a member at all. A spec
 * whose source is gone from settings is inert — lazy never activates a package pi
 * has not registered — so both halves must go or the spec lingers as a permanently
 * failing entry in `/lazy list`.
 *
 * Both files are backed up before the first write; `/lazy restore` undoes it.
 * Nothing is reloaded automatically — pi's own `/reload` is the only point at
 * which the change takes effect, because a loaded extension factory has no
 * inverse operation.
 */
/**
 * Catalog members that `/lazy disable <name>` could remove.
 *
 * Read straight from lazy.json rather than the in-session table: the runtime
 * view already dropped anything not currently loaded, which is exactly the set
 * the user may want to disable.
 */
interface RescueResult {
	ok: boolean;
	handedBack: string[];
	keptOverrides: string[];
	specsCleared: number;
	backups: string[];
	error?: string;
}

/**
 * Hand every package back to native Pi: no deferred loading, no lazy catalog.
 *
 * The escape hatch for a config that has been broken badly enough that the other
 * subcommands are unusable. Two halves, both required:
 *
 * 1. settings.packages — remove the `extensions: []` filter lazy wrote, which
 *    restores the plain string form and makes Pi instantiate each package's
 *    extension factory at startup again. Entries carrying `+`/`-` filters are
 *    left alone: those state an explicit per-entrypoint intent that predates
 *    lazy (extmgr wrote them), and stripping them would change behaviour the
 *    operator did not ask to change.
 * 2. lazy.json — empty the spec list. Deleting the file is not an option:
 *    loadConfig() regenerates a built-in catalog when it is missing, so removing
 *    it would hand control straight back to the extension on next start. An
 *    empty-but-present catalog means migrate has nothing to act on.
 *
 * Backups are written before the first write; restoring them is the way back.
 */
function rescueNative(agentDir: string): RescueResult {
	const configPath = getLazyConfigPath(agentDir);
	const settingsPath = getSettingsPath(agentDir);
	const config = loadConfig(agentDir);
	const specsCleared = config.specs.length;

	const handedBack: string[] = [];
	const keptOverrides: string[] = [];

	let settings: Record<string, unknown> | null = null;
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
		} catch (err) {
			return { ok: false, handedBack, keptOverrides, specsCleared, backups: [], error: `settings.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backups: string[] = [];
	if (existsSync(configPath)) {
		const b = `${configPath}.bak.rescue-${stamp}`;
		copyFileSync(configPath, b);
		backups.push(b);
	}
	if (settings && existsSync(settingsPath)) {
		const b = `${settingsPath}.bak.rescue-${stamp}`;
		copyFileSync(settingsPath, b);
		backups.push(b);
	}

	try {
		if (settings && Array.isArray(settings.packages)) {
			settings.packages = (settings.packages as unknown[]).map((entry) => {
				if (!entry || typeof entry !== "object") return entry;
				const obj = entry as Record<string, unknown>;
				if (!(Array.isArray(obj.extensions) && obj.extensions.length === 0)) {
					const src = typeof obj.source === "string" ? obj.source : null;
					if (src && Array.isArray(obj.extensions)) keptOverrides.push(src);
					return entry;
				}
				const { extensions, ...rest } = obj;
				if (typeof rest.source === "string") {
					handedBack.push(rest.source);
					return rest.source;
				}
				handedBack.push("(unnamed)");
				return rest;
			});
			atomicWriteJson(settingsPath, settings);
		}
		saveConfig({ ...config, specs: [] }, agentDir);
	} catch (err) {
		return { ok: false, handedBack, keptOverrides, specsCleared, backups, error: err instanceof Error ? err.message : String(err) };
	}

	return { ok: true, handedBack, keptOverrides, specsCleared, backups };
}

/**
 * Package roster, refreshed by `/lazy init` and read by `/lazy disable` and
 * `/lazy enable`.
 *
 * Both subcommands need the same full picture, so it is computed once per init
 * and stored on disk: reading and re-parsing both config files on every bare
 * invocation would repeat the same work for no benefit, and the answer only
 * changes when the set of installed packages does — which is what init is for.
 *
 * `disable` may be given any catalog member; `enable` may be given any entry in
 * `all`, because the two lists are simply the whole roster. Re-disabling an
 * already-disabled package or re-enabling an already-enabled one is reported as
 * such rather than treated as an error: the operator asked, and the state they
 * wanted is already what they have.
 */
const ROSTER_PATH = "lazy-roster.json";

interface RosterEntry {
	name: string;
	source: string;
	mode: string;
}

interface Roster {
	version: 1;
	generatedAt: string;
	all: RosterEntry[];
}

function rosterPath(agentDir: string): string {
	return join(agentDir, ROSTER_PATH);
}

/** Read the stored roster, recomputing it if it was never written. */
function loadRoster(agentDir: string): Roster {
	const path = rosterPath(agentDir);
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Roster;
			if (parsed && Array.isArray(parsed.all)) return parsed;
		} catch {
			// fall through to a fresh scan
		}
	}
	return buildRoster(agentDir);
}

/**
 * Every installed package, whatever state lazy holds it in.
 *
 * Union of the catalog (packages lazy manages) and settings.packages (packages
 * pi registers), keyed by `source` so a package appearing in both is listed once.
 */
function buildRoster(agentDir: string): Roster {
	const config = loadConfig(agentDir);
	const seen = new Map<string, RosterEntry>();

	for (const spec of config.specs) {
		seen.set(normalizeSourceKey(spec.source), {
			name: spec.name,
			source: spec.source,
			mode: typeof spec.lazy === "boolean" ? (spec.lazy ? "lazy" : "eager") : String(spec.lazy),
		});
	}

	const settingsPath = getSettingsPath(agentDir);
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: unknown[] };
			for (const entry of parsed.packages ?? []) {
				const src = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
				if (typeof src !== "string" || seen.has(normalizeSourceKey(src))) continue;
				seen.set(normalizeSourceKey(src), {
					name: (npmPackageName(src) ?? src).split("/").pop() ?? src,
					source: src,
					mode: typeof entry === "string" ? "eager" : "custom",
				});
			}
		} catch {
			// settings unreadable — the catalog half is still worth showing
		}
	}

	return { version: 1, generatedAt: new Date().toISOString(), all: [...seen.values()] };
}

/**
 * Routine notices when bootQuiet is on: append to logs/pi-lazy.log instead of
 * the terminal. The TUI does not capture stderr, so console.error lands raw on
 * the screen and smears over the chat frame — the exact symptom bootQuiet
 * exists to stop. Failures never route here; they keep their notify path.
 */
function lazyLog(agentDir: string, line: string): void {
	try {
		const dir = join(agentDir, "logs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pi-lazy.log"), `[${new Date().toISOString()}] ${line}\n`, { flag: "a" });
	} catch {
		/* log unavailable — a routine notice dying quietly is the accepted cost */
	}
}

/** Recompute and persist the roster. Called by `/lazy init`. */
function refreshRoster(agentDir: string): Roster {
	const roster = buildRoster(agentDir);
	try {
		atomicWriteJson(rosterPath(agentDir), roster);
	} catch (err) {
		console.error(`[pi-lazy] failed to write roster: ${err instanceof Error ? err.message : String(err)}`);
	}
	return roster;
}

function formatRoster(roster: Roster, verb: string): string {
	if (roster.all.length === 0) return "no packages recorded — run /lazy init first";
	return [
		`packages for /lazy ${verb} (${roster.all.length}, from lazy-roster.json):`,
		...roster.all.map((e) => `  ${e.name}  [${e.mode}]  ${e.source}`),
		"",
		`usage: /lazy ${verb} <name>`,
	].join("\n");
}

/**
 * Re-enable a package previously removed by `/lazy disable`.
 *
 * The mirror image of disablePackage: put the settings entry and the catalog spec
 * back. The spec's original mode (lazy / after-start / eager) comes from the most
 * recent `*.bak.disable-*` snapshot that still contains it, so a disabled package
 * comes back the way it left.
 *
 * node_modules is never touched in either direction — `pi install npm:<name>`
 * stays the way to add or remove the package itself.
 */
function enablePackage(agentDir: string, name: string): EnableResult {
	const configPath = getLazyConfigPath(agentDir);
	const settingsPath = getSettingsPath(agentDir);
	const config = loadConfig(agentDir);

	// Already in the catalog: not an error. The roster is the whole package list
	// for both verbs, so re-enabling an enabled package is a request the operator
	// is entitled to make; the state they asked for is already what they have.
	// Report it so the answer is still explicit rather than silently re-written.
	if (config.specs.some((s) => s.name === name || sourcesMatch(s.source, name))) {
		const existing = config.specs.find((s) => s.name === name || sourcesMatch(s.source, name));
		return {
			ok: true,
			restoredSpec: false,
			restoredEntry: false,
			mode: existing ? (typeof existing.lazy === "boolean" ? (existing.lazy ? "lazy" : "eager") : String(existing.lazy)) : undefined,
			backups: [],
			noop: true,
		};
	}

	// Recover the original spec from the newest disable backup that has one.
	let recovered: LazySpec | null = null;
	let specBackup: string | null = null;
	if (existsSync(configPath)) {
		const dir = dirname(configPath);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		let candidates: string[] = [];
		try {
			candidates = readdirSync(dir)
				.filter((f) => f.startsWith(`${basename(configPath)}.bak.disable-`))
				.sort()
				.reverse();
		} catch {
			candidates = [];
		}
		for (const file of candidates) {
			try {
				const snap = JSON.parse(readFileSync(join(dir, file), "utf-8")) as LazyConfig;
				const hit = snap.specs?.find((s) => s.name === name || sourcesMatch(s.source, name));
				if (hit) {
					recovered = hit;
					specBackup = join(dir, file);
					break;
				}
			} catch {
				// skip unreadable snapshot
			}
		}
	}

	let settings: Record<string, unknown> | null = null;
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
		} catch (err) {
			return { ok: false, restoredSpec: false, backups: [], error: `settings.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	// Recover the settings entry too, from the paired settings backup.
	const packages = settings && Array.isArray(settings.packages) ? [...(settings.packages as unknown[])] : [];
	let entry: unknown = null;
	let settingsBackup: string | null = null;
	if (existsSync(settingsPath)) {
		const dir = dirname(settingsPath);
		const base = basename(settingsPath);
		let candidates: string[] = [];
		try {
			candidates = readdirSync(dir)
				.filter((f) => f.startsWith(`${base}.bak.disable-`))
				.sort()
				.reverse();
		} catch {
			candidates = [];
		}
		for (const file of candidates) {
			try {
				const snap = JSON.parse(readFileSync(join(dir, file), "utf-8")) as { packages?: unknown[] };
				const hit = (snap.packages ?? []).find((p) => {
					const src = typeof p === "string" ? p : (p as { source?: unknown })?.source;
					return typeof src === "string" && (sourcesMatch(src, name) || sourcesMatch(src, recovered?.source ?? name));
				});
				if (hit) {
					entry = hit;
					settingsBackup = join(dir, file);
					break;
				}
			} catch {
				// skip unreadable snapshot
			}
		}
	}

	const source = recovered?.source ?? (typeof entry === "string" ? entry : (entry as { source?: string })?.source) ?? name;
	if (!recovered && !entry) {
		return {
			ok: false,
			restoredSpec: false,
			backups: [],
			error: `no record of "${name}" in any *.bak.disable-* snapshot — re-add the spec to lazy.json by hand`,
		};
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backups: string[] = [];
	if (existsSync(configPath)) {
		const b = `${configPath}.bak.enable-${stamp}`;
		copyFileSync(configPath, b);
		backups.push(b);
	}
	if (existsSync(settingsPath)) {
		const b = `${settingsPath}.bak.enable-${stamp}`;
		copyFileSync(settingsPath, b);
		backups.push(b);
	}

	try {
		if (recovered) {
			const next: LazyConfig = { ...config, specs: [...config.specs, recovered] };
			saveConfig(next, agentDir);
		}
		if (settings && entry && !packages.some((p) => {
			const src = typeof p === "string" ? p : (p as { source?: unknown })?.source;
			return typeof src === "string" && sourcesMatch(src, source);
		})) {
			settings.packages = [...packages, entry];
			atomicWriteJson(settingsPath, settings);
		}
	} catch (err) {
		return { ok: false, restoredSpec: false, backups, error: err instanceof Error ? err.message : String(err) };
	}

	const migration = migrateSettings(agentDir);

	return {
		ok: true,
		restoredSpec: recovered !== null,
		restoredEntry: entry !== null,
		mode: recovered ? (typeof recovered.lazy === "boolean" ? (recovered.lazy ? "lazy" : "eager") : String(recovered.lazy)) : undefined,
		specFrom: specBackup ?? undefined,
		entryFrom: settingsBackup ?? undefined,
		migrated: migration.ok ? migration.changed.length : 0,
		migrateSkipped: migration.ok ? migration.skipped.length : 0,
		migrateError: migration.ok ? undefined : migration.error,
		backups,
	};
}

function disablePackage(agentDir: string, name: string): DisableResult {
	const configPath = getLazyConfigPath(agentDir);
	const settingsPath = getSettingsPath(agentDir);
	const config = loadConfig(agentDir);

	const spec = config.specs.find((s) => s.name === name)
		?? config.specs.find((s) => sourcesMatch(s.source, name))
		?? config.specs.find((s) => s.name.toLowerCase().includes(name.toLowerCase()));
	if (!spec) {
		// Not in the catalog: already disabled, or simply a name that was never
		// tracked. Either way the requested state already holds. The roster is the
		// full package list for both verbs, so this is a normal answer, not a fault.
		return { ok: true, noop: true, droppedFromSettings: false, backups: [] };
	}

	let settings: Record<string, unknown> | null = null;
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
		} catch (err) {
			return { ok: false, droppedFromSettings: false, backups: [], error: `settings.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	const packages = settings && Array.isArray(settings.packages) ? [...(settings.packages as unknown[])] : [];
	const keep = packages.filter((entry) => {
		const src = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
		return typeof src !== "string" || !sourcesMatch(src, spec.source);
	});
	const droppedFromSettings = keep.length !== packages.length;

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backups: string[] = [];

	if (existsSync(configPath)) {
		const backup = `${configPath}.bak.disable-${stamp}`;
		copyFileSync(configPath, backup);
		backups.push(backup);
	}
	if (droppedFromSettings && settings && existsSync(settingsPath)) {
		const backup = `${settingsPath}.bak.disable-${stamp}`;
		copyFileSync(settingsPath, backup);
		backups.push(backup);
	}

	try {
		const next: LazyConfig = { ...config, specs: config.specs.filter((s) => s !== spec) };
		saveConfig(next, agentDir);
		if (settings && droppedFromSettings) {
			settings.packages = keep;
			atomicWriteJson(settingsPath, settings);
		}
		// The package is out of both files, so migrate has no entry left to translate —
		// it runs to confirm nothing else in the catalog drifted, not to change this
		// package. Kept so every mutating subcommand lands settings and lazy.json in
		// the same state, whatever the operator changed before running it.
	} catch (err) {
		return { ok: false, droppedFromSettings, backups, error: err instanceof Error ? err.message : String(err) };
	}

	const migration = migrateSettings(agentDir);
	return {
		ok: true,
		droppedFromSettings,
		migrated: migration.ok ? migration.changed.length : 0,
		migrateSkipped: migration.ok ? migration.skipped.length : 0,
		backups,
	};
}

function refreshStatus(pi: ExtensionAPI, rt: Runtime, ctx?: ExtensionContext) {
	rt.status = formatStatus(rt);
	globalThis.__piLazyStatus = rt.status;
	globalThis.__piLazyManagedSources = new Set(
		[...rt.entries.values()]
			.filter((e) => e.spec.lazy !== false)
			.map((e) => e.spec.source),
	);
	// Fork P6/P7/P10: the status line is rendered by persona-loader's widget on
	// the top (reads globalThis.__piLazyStatus) — do NOT call ui.setStatus here
	// or a duplicate copy appears in the bottom status bar. __piLazyManagedSources
	// is consumed by pi-extmgr's compat layer (ensureManagerCompat).
}

/** Best-effort notify: a stale ctx must never crash the whole pi process. */
function notifySafe(ctx: ExtensionContext | undefined, message: string, type?: "info" | "warning" | "error") {
	if (!ctx) return;
	try {
		ctx.ui.notify(message, type);
	} catch {
		// stale ctx — session was replaced/reloaded since this ctx was captured.
	}
}

function runDoctor(agentDir: string, rt: Runtime) {
  const lines = [];
  const settingsPath = getSettingsPath(agentDir);
  try {
    const rawCfg = JSON.parse(readFileSync(getLazyConfigPath(agentDir), "utf-8"));
    const rawSpecs = Array.isArray(rawCfg?.specs) ? rawCfg.specs : [];
    for (const s of rawSpecs) {
      const v = s?.lazy;
      if (v !== void 0 && v !== false && v !== true && v !== "after-start") {
        lines.push(`X spec "${s?.name ?? "?"}": lazy 值非法 ${JSON.stringify(v)}（只能 false / true / "after-start"）→ 该 spec 被静默丢弃`);
      }
    }
  } catch (err) {
    lines.push(`X lazy.json 解析失败（正在用内置兜底目录，部分包不会加载）: ${err instanceof Error ? err.message : String(err)}`);
  }
  let packages;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    packages = Array.isArray(parsed.packages) ? parsed.packages : [];
  } catch (err) {
    lines.push(`X settings.json 读取失败: ${err instanceof Error ? err.message : String(err)}`);
    return lines;
  }
  const sourceOf = (p: unknown): string =>
    typeof p === "string" ? p : p && typeof p === "object" && "source" in p && typeof p.source === "string" ? p.source : "";
  const counts = /* @__PURE__ */ new Map();
  for (const p of packages) {
    const src = sourceOf(p);
    if (src) counts.set(src, (counts.get(src) ?? 0) + 1);
  }
  for (const [src, n] of counts) if (n > 1) lines.push(`X settings 重复条目 x${n}: ${src}`);
  const extDir = join(agentDir, "extensions");
  for (const p of packages) {
    if (p && typeof p === "object" && sourceOf(p).startsWith(extDir)) {
      lines.push(`X 重复登记（settings 与 extensions/ 目录都会加载，会跑两遍）: ${sourceOf(p)}`);
    }
  }
  for (const spec of rt.config.specs) {
    const managed = spec.lazy !== false;
    const idx = findSettingsPackageIndices(packages, spec.source);
    if (idx.length === 0) {
      lines.push(`- ${spec.name}: 未注册在 settings（lazy 不会碰它）`);
      continue;
    }
    if (idx.length > 1) {
      lines.push(`X ${spec.name}: settings 里有 ${idx.length} 条重复`);
      continue;
    }
    const entry = packages[idx[0]];
    if (typeof entry === "string") {
      if (managed)
        lines.push(
          `· ${spec.name}: 纯字符串 = pi 启动即加载（现在就是可用状态）。lazy=${JSON.stringify(spec.lazy)} 尚未接管；跑 /lazy migrate 会改写成 [] 交给 lazy，届时要等 after-start/触发才出现`,
        );
      continue;
    }
    const filters = Array.isArray(entry.extensions) ? entry.extensions : [];
    const blocking = filters.some((t: unknown) => typeof t === "string" && (t.trim().startsWith("-") || t.trim().startsWith("!")));
    if (filters.length === 0) {
      if (!managed) lines.push(`! ${spec.name}: 已被 lazy 接管但 lazy=false → /lazy migrate 交回 extmgr`);
    } else if (blocking) {
      lines.push(`! ${spec.name}: 带排除标记 ${JSON.stringify(filters)} → lazy 让位（归 extmgr / pi config）`);
    } else {
      lines.push(`! ${spec.name}: 带放行标记 ${JSON.stringify(filters)} → 下次 /lazy migrate 会收回为 []`);
    }
    const triggers = (spec.cmd ?? []).length + (spec.tools ?? []).length + (spec.keys ?? []).length + (spec.keywords ?? []).length + (spec.event ?? []).length;
    if (spec.lazy === true && triggers === 0) {
      lines.push(`   ↳ 无触发入口（lazy=true）：只能 /lazy load ${spec.name}（或模型调 lazy_load）`);
    }
  }
  const specSources = rt.config.specs.map((s) => s.source);
  const outside = packages.filter((p: unknown) => {
    const src = sourceOf(p);
    return !!src && !specSources.some((s) => sourcesMatch(src, s));
  });
  const nobodyLoads: string[] = [];
  const eagerOutside: string[] = [];
  for (const p of outside) {
    const src = sourceOf(p);
    const ext = typeof p === "object" && p !== null ? (p as { extensions?: unknown }).extensions : undefined;
    // settings 里 extensions:[] 在 pi 眼里 = 这个包的所有扩展都禁用。
    // 如果 lazy.json 里又没有它，就没有任何一方会加载它 → 命令/工具都不会注册。
    if (Array.isArray(ext) && ext.length === 0) nobodyLoads.push(src);
    else eagerOutside.push(src);
  }
  if (nobodyLoads.length) {
    lines.push(`X 没人加载（settings 是 extensions:[] 但 lazy.json 里没有它 → pi 不加载、lazy 也不管）: ${nobodyLoads.join(", ")}`);
    lines.push(`   ↳ 后果：这些包的命令/工具都不会注册（pi-extmgr 整个失效就是这条）`);
    lines.push(`   ↳ 修法二选一：① settings 里改回普通字符串，让 pi 启动即加载；② 加进 lazy.json 并写对触发名`);
  }
  if (eagerOutside.length) lines.push(`- 未纳入 lazy（启动即加载）: ${eagerOutside.join(", ")}`);
  if (rt.entries && typeof rt.entries.values === "function") {
    const all = [...rt.entries.values()];
    for (const e of all) {
      if (e.state === "error" || e.state === "poisoned") {
        lines.push(`X ${e.spec.name}: 加载失败 (${e.state}) ${e.error ?? ""}`.trim());
      }
    }
    const stuck = all.filter((e) => e.state === "pending" && e.spec.lazy === "after-start");
    if (stuck.length && !rt.afterStartQueued) {
      lines.push(`X after-start 队列已结束但仍有 ${stuck.length} 个 pending（= 懒加载没生效）: ${stuck.map((e) => e.spec.name).join(", ")}`);
    }
    const loaded = all.filter((e) => e.state === "loaded").length;
    lines.push(`· 运行态: ${loaded} loaded / ${all.filter((e) => e.state === "pending").length} pending / ${all.filter((e) => e.state === "eager").length} eager${rt.afterStartQueued ? " (after-start 队列进行中)" : ""}`);
  }
  // pi-extmgr 兼容补丁：重装/更新 pi-extmgr 会被上游源码冲掉
  const extmgrFile = join(agentDir, "npm", "node_modules", "pi-extmgr", "src", "packages", "extensions.ts");
  if (rt.config.managerCompat !== true) {
    lines.push(`- extmgr 兼容补丁: 关闭（lazy.json 里 managerCompat 不是 true）→ 面板会把懒加载包显示成 Disabled`);
  } else if (!existsSync(extmgrFile)) {
    lines.push(`· extmgr 兼容补丁: 未安装 pi-extmgr，跳过`);
  } else {
    let patched = false;
    try {
      patched = readFileSync(extmgrFile, "utf-8").includes("__piLazyManagedSources");
    } catch {
      /* ignore */
    }
    lines.push(
      patched
        ? `· extmgr 兼容补丁: 已就位（重装/更新 pi-extmgr 会冲掉；重启 pi 或再跑一次 /lazy doctor 会自动补回）`
        : `X extmgr 兼容补丁: 曾缺失，本次已自动补回 → 需重启 pi 才生效（面板模块一旦加载就缓存到进程结束）`,
    );
  }
  return lines.length ? lines : ["clean: 未发现异常"];
}

function ensureManagerCompat(agentDir: string, rt: Runtime) {
  if (rt.config.managerCompat !== true) return;
  const file = join(agentDir, "npm", "node_modules", "pi-extmgr", "src", "packages", "extensions.ts");
  if (!existsSync(file)) return;
  let src;
  try {
    src = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  if (src.includes("__piLazyManagedSources")) return; // 已打过
  // 三处替换，全部命中才写入（全有或全无）
  const steps = [
    [
      "    const resolvedResources = resourcesForPackage(canonicalResources, pkg.source, pkg.scope);\n",
      "    const resolvedResources = resourcesForPackage(canonicalResources, pkg.source, pkg.scope);\n" +
        "    const pkgFiltersLazy =\n" +
        '      (pkg.scope === "global" ? globalFilterMap : projectFilterMap).get(\n' +
        "        normalizeConfiguredPackageSource(pkg.source)\n" +
        "      ) ?? undefined;\n" +
        "    // pi-lazy 兼容：settings 里 extensions:[] + 该包被 lazy 接管 = 延迟加载，不是禁用\n" +
        "    // 只认 []（lazy 已接管）；带 -/! 标记的条目是 extmgr 自己禁的，保持 disabled\n" +
        "    const lazyDeferred =\n" +
        "      Array.isArray(pkgFiltersLazy) &&\n" +
        "      pkgFiltersLazy.length === 0 &&\n" +
        "      !!(globalThis as { __piLazyManagedSources?: Set<string> }).__piLazyManagedSources?.has(\n" +
        "        pkg.source\n" +
        "      );\n",
    ],
    [
      '          state: resource.enabled ? "enabled" : "disabled",',
      '          state: resource.enabled || lazyDeferred ? "enabled" : "disabled",',
    ],
    [
      "      const state = getPackageFilterState(packageFilters, normalizedPath);",
      '      let state = getPackageFilterState(packageFilters, normalizedPath);\n      if (state === "disabled" && lazyDeferred) state = "enabled";',
    ],
  ];
  for (const [anchor] of steps) {
    if (!src.includes(anchor)) {
      console.error("[pi-lazy] pi-extmgr 兼容补丁跳过：锚点未命中 " + JSON.stringify(anchor.slice(0, 50)));
      return;
    }
  }
  for (const [anchor, replacement] of steps) src = src.replace(anchor, replacement);
  try {
    writeFileSync(file, src);
    console.error("[pi-lazy] re-patched pi-extmgr for lazy compat (restart to take effect)");
  } catch {
  }
}

function ensureFooterCompat(agentDir: string, rt: Runtime) {
  if (rt.config.footerCompat === false) return;
  const dir = join(agentDir, "npm", "node_modules", "pi-powerline-footer");
  const indexFile = join(dir, "index.ts");
  const welcomeFile = join(dir, "welcome.ts");
  if (!existsSync(indexFile) || !existsSync(welcomeFile)) return;
  let indexSrc;
  let welcomeSrc;
  try {
    indexSrc = readFileSync(indexFile, "utf-8");
    welcomeSrc = readFileSync(welcomeFile, "utf-8");
  } catch {
    return;
  }
  // 幂等：两个文件都已带标记就跳过
  if (indexSrc.includes("getRecentSessionsFast") && welcomeSrc.includes("setRecentSessions")) return;
  const helper = `  // [本地补丁] 欢迎浮层/顶栏不再等 getRecentSessions
  //
  // 原因：getRecentSessions 会对「最近 3 个会话日志」做 open()，其中最新那个就是当前正在写入的会话文件。
  // 实测（本机 Windows + Defender）：对该文件的首次 open 要 ~8s（同进程第二次 0ms，已关闭的旧文件 0ms，
  // 包括 12.9MB 的也是 0ms）→ 卡的是「刚被写过的活跃文件」，不是体积。
  // 这一行 await 原本就在欢迎浮层/顶栏的渲染路径上，于是：
  //   t≈100ms  浮层开始准备
  //   t≈750ms  pi-lazy 的 after-start 队列起跑（每包 ~0.5-0.9s，间隔让出 ≤250ms，最后一包 ~6s）
  //   t≈8s     上面那个 open 才返回 → 队列早跑完了 → 浮层才画出来
  // 观感就是「懒加载全部跑完，美化弹窗才蹦出来」。
  //
  // 修法：给最近会话列表一个很短的超时，超时就用空列表先把 UI 画出来，不阻塞首帧；
  // 真正的列表迟到时再补画（顶栏重新 setHeader，浮层 setRecentSessions + requestRender）。
  async function getRecentSessionsFast(request: AbortController): Promise<RecentSession[]> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        getRecentSessions(3, request.signal),
        new Promise<RecentSession[]>((resolve) => {
          timer = setTimeout(() => resolve([]), WELCOME_RECENT_SESSIONS_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

`;
  const headerLate = `        // [本地补丁] 上面超时了就先用空列表把顶栏画出来，等真正的最近会话到了再补画一次。
        if (recentSessions.length === 0) {
          void getRecentSessions(3, request.signal).then((lateSessions) => {
            if (lateSessions.length === 0 || !welcomeHeaderActive) return;
            if (!canShowWelcome(ctx, request, generation)) return;
            ctx.ui.setHeader(() => new WelcomeHeader(
              modelName,
              providerName,
              lateSessions,
              discoverLoadedCounts(pi.getCommands()),
              estimateInitialContextTokens(ctx),
            ));
          }).catch(() => {});
        }
`;
  const overlayLate = `            // [本地补丁] 上面超时了就先弹空列表的浮层，等真正的最近会话到了再回填重画。
            if (recentSessions.length === 0) {
              void getRecentSessions(3, request.signal).then((lateSessions) => {
                if (dismissed || lateSessions.length === 0) return;
                welcome.setRecentSessions(lateSessions);
                tui.requestRender();
              }).catch(() => {});
            }
`;
  const plan = [
    {
      file: indexFile,
      src: indexSrc,
      steps: [
        [
          'import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "./welcome.ts";\n',
          'import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions, type RecentSession } from "./welcome.ts";\n',
        ],
        [
          "const STASH_PREVIEW_WIDTH = 72;\n",
          "const STASH_PREVIEW_WIDTH = 72;\n// [本地补丁] 欢迎浮层/顶栏等最近会话列表的上限；超时先画空列表（详见 getRecentSessionsFast）。\nconst WELCOME_RECENT_SESSIONS_TIMEOUT_MS = 400;\n",
        ],
        ["  function setupWelcomeHeader(ctx: any) {", helper + "  function setupWelcomeHeader(ctx: any) {"],
        [
          "        const recentSessions = await getRecentSessions(3, request.signal);\n        if (!canShowWelcome(ctx, request, generation)) return;\n",
          "        const recentSessions = await getRecentSessionsFast(request);\n        if (!canShowWelcome(ctx, request, generation)) return;\n",
        ],
        [
          "        welcomeHeaderActive = true;\n        ctx.ui.setHeader(() => header);\n",
          "        welcomeHeaderActive = true;\n        ctx.ui.setHeader(() => header);\n\n" + headerLate,
        ],
        [
          "        if (!canShowWelcome(ctx, request, overlaySessionGeneration)) return;\n        const recentSessions = await getRecentSessions(3, request.signal);\n",
          "        if (!canShowWelcome(ctx, request, overlaySessionGeneration)) return;\n        const recentSessions = await getRecentSessionsFast(request);\n",
        ],
        [
          "            const welcome = new WelcomeComponent(\n              modelName,\n              providerName,\n              recentSessions,\n              loadedCounts,\n              initialContextTokens,\n            );\n",
          "            const welcome = new WelcomeComponent(\n              modelName,\n              providerName,\n              recentSessions,\n              loadedCounts,\n              initialContextTokens,\n            );\n\n" + overlayLate,
        ],
      ],
    },
    {
      file: welcomeFile,
      src: welcomeSrc,
      steps: [
        [
          "  setCountdown(seconds: number): void {\n    this.countdown = seconds;\n  }\n",
          "  setCountdown(seconds: number): void {\n    this.countdown = seconds;\n  }\n\n  // [本地补丁] 首帧不再等 getRecentSessions（见 index.ts 的 getRecentSessionsFast 注释）。\n  // 最近会话列表迟到时，由 index.ts 回填并 requestRender。\n  setRecentSessions(sessions: RecentSession[]): void {\n    this.data = { ...this.data, recentSessions: sessions };\n  }\n",
        ],
      ],
    },
  ];
  const outs = [];
  for (const p of plan) {
    let out = p.src;
    for (const [anchor, repl] of p.steps) {
      const hits = out.split(anchor).length - 1;
      if (hits !== 1) {
        console.error(`[pi-lazy] pi-powerline-footer 兼容补丁跳过：锚点未命中或重复（${hits} 次）${JSON.stringify(anchor.slice(0, 60))}`);
        return;
      }
      out = out.replace(anchor, () => repl);
    }
    outs.push([p.file, out]);
  }
  try {
    for (const [file, out] of outs) writeFileSync(file, out);
  } catch (err) {
    console.error(`[pi-lazy] pi-powerline-footer 兼容补丁写入失败: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  console.error("[pi-lazy] re-patched pi-powerline-footer for fast welcome (restart to take effect)");
}

function recordTiming(rt: Runtime, label: string, started: number) {
	rt.profile.push({ label, ms: performance.now() - started });
	if (rt.profile.length > 100) rt.profile.shift();
}

/**
 * Resolve package metadata on first use, not during startup catalog creation.
 * Returns false only when resolution threw; a package that is simply not
 * installed resolves to empty paths and is reported later by the loader.
 */
function ensureResolved(rt: Runtime, entry: ResolvedEntry, ctx?: ExtensionContext): boolean {
	if (entry.resolveAttempted) return true;
	const started = performance.now();
	try {
		const resolved = resolveSpecPaths(entry.spec, getAgentDir(), (ctx ?? rt.sessionCtx)?.cwd ?? process.cwd());
		entry.packageRoot = resolved.packageRoot ?? "";
		entry.extensionPaths = resolved.extensionPaths;
		entry.resolveMs = performance.now() - started;
		entry.resolveAttempted = true;
		recordTiming(rt, `resolve:${entry.spec.name}`, started);
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		entry.resolveAttempted = true;
		entry.state = "error";
		entry.error = `failed to resolve ${entry.spec.source}: ${message}`;
		return false;
	}
}

/**
 * Import an upcoming entry's modules while the current one activates. Purely an
 * optimization: any failure is swallowed here and re-surfaced by the real load.
 */
async function prefetchQuietly(rt: Runtime, entry: ResolvedEntry, ctx?: ExtensionContext) {
	try {
		if (entry.state !== "pending" || !entry.moduleLazyReady) return;
		if (!ensureResolved(rt, entry, ctx)) return;
		const started = performance.now();
		await prefetchEntry(entry);
		if (entry.prefetchedFactories) recordTiming(rt, `prefetch:${entry.spec.name}`, started);
	} catch {
		/* the real load re-imports and reports the error */
	}
}

async function loadByName(
	pi: ExtensionAPI,
	rt: Runtime,
	name: string,
	ctx?: ExtensionContext,
	ancestry: string[] = [],
): Promise<LoadResult> {
	const key = name.trim();
	if (!key) return { ok: false, name: key, error: "spec name must not be empty" };
	const entry =
		rt.entries.get(key) ??
		[...rt.entries.values()].find(
			(e) => e.spec.source === key || e.spec.name.toLowerCase() === key.toLowerCase(),
		);

	if (!entry) {
		return { ok: false, name: key, error: `unknown spec '${key}' — see /lazy list` };
	}

	// Eager packages are already loaded by Pi
	if (entry.state === "eager") {
		return {
			ok: true,
			name: entry.spec.name,
			alreadyLoaded: true,
			error: undefined,
		};
	}

	if (!ensureResolved(rt, entry, ctx)) {
		return { ok: false, name: entry.spec.name, error: entry.error };
	}
	const started = performance.now();
	const result = await loadResolvedEntry(entry, pi, ctx ?? rt.sessionCtx, {
		ancestry,
		loadDependency: (dep, nextAncestry) => loadByName(pi, rt, dep, ctx, nextAncestry),
	});
	recordTiming(rt, `load:${entry.spec.name}`, started);

	refreshStatus(pi, rt, ctx ?? rt.sessionCtx);
	learnCommandsToSpec(rt, entry, result);
	return result;
}

/**
 * P12 learn-cmd: after a package loads, write any commands it registered
 * that are missing from its spec.cmd back into lazy.json. Next startup the
 * stub exists, so the command palette works without a manual /lazy edit.
 * Best effort — a failure to save never breaks the load itself.
 */
function learnCommandsToSpec(rt: Runtime, entry: ResolvedEntry, result: LoadResult) {
	try {
		if (!result.ok || !result.commands?.length) return;
		const spec = entry.spec;
		const declared = new Set(spec.cmd ?? []);
		const missing = [...new Set(result.commands)].filter((c) => !declared.has(c));
		if (!missing.length) return;
		const configSpec = rt.config.specs.find((s) => s.name === spec.name);
		if (!configSpec) return;
		configSpec.cmd = [...(configSpec.cmd ?? []), ...missing];
		saveConfig(rt.config);
		const line = `[pi-lazy] learned cmd [${missing.join(", ")}] for '${spec.name}' — saved to lazy.json`;
		if (rt.config.bootQuiet !== false) lazyLog(getAgentDir(), line);
		else console.error(line);
	} catch (err) {
		console.error(`[pi-lazy] learn-cmd save failed for '${entry.spec.name}': ${err instanceof Error ? err.message : String(err)}`);
	}
}

function registerStubs(pi: ExtensionAPI, rt: Runtime) {
	const cmdOwners = new Map<string, string>(); // cmd -> spec name
	const toolOwners = new Map<string, string>();

	for (const entry of rt.entries.values()) {
		if (entry.state !== "pending") continue;
		const { spec } = entry;
		for (const cmd of spec.cmd ?? []) {
			if (cmdOwners.has(cmd)) {
				console.error(`[pi-lazy] command stub '${cmd}' is claimed by both '${cmdOwners.get(cmd)}' and '${spec.name}'`);
				continue;
			}
			cmdOwners.set(cmd, spec.name);
		}
		for (const tool of spec.tools ?? []) {
			if (toolOwners.has(tool)) {
				console.error(`[pi-lazy] tool stub '${tool}' is claimed by both '${toolOwners.get(tool)}' and '${spec.name}'`);
				continue;
			}
			toolOwners.set(tool, spec.name);
		}
		for (const key of spec.keys ?? []) {
			try {
				pi.registerShortcut(key as any, {
					description: `Load lazy package ${spec.name}`,
					handler: async (ctx) => {
						const res = await loadByName(pi, rt, spec.name, ctx);
						ctx.ui.notify(
							res.ok
								? res.alreadyLoaded
									? `${spec.name} already loaded`
									: `loaded ${spec.name}${res.loadMs != null ? ` (${res.loadMs}ms)` : ""}`
								: `failed ${spec.name}: ${res.error}`,
							res.ok ? "info" : "error",
						);
					},
				});
			} catch {
				/* duplicate shortcut */
			}
		}
	}

	for (const [cmd, owner] of cmdOwners) {
		pi.registerCommand(cmd, {
			description: `[lazy] load ${owner} then run /${cmd}`,
			handler: async (args, ctx) => {
				const res = await loadByName(pi, rt, owner, ctx);
				if (!res.ok) {
					ctx.ui.notify(`lazy: failed to load ${owner}: ${res.error}`, "error");
					return;
				}
				if (!res.alreadyLoaded) {
					ctx.ui.notify(`lazy: loaded ${owner}${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}`, "info");
				}
				// Call the real command's handler in-process. sendUserMessage()
				// injects text back into the conversation as a literal chat
				// message rather than re-running slash-command dispatch, so a
				// re-sent "/cmd" never reaches the newly loaded handler — it
				// just gets shown to the LLM as a stray prompt.
				const real = rt.entries.get(owner)?.loadedCommandHandlers?.get(cmd);
				if (real) {
					await real(args, ctx);
					return;
				}
					ctx.ui.notify(
						`lazy: '${owner}' loaded but did not register /${cmd}; update lazy.json to the package's actual command name`,
						"error",
					);
				},
		});
	}

	for (const [toolName, owner] of toolOwners) {
		pi.registerTool({
			name: toolName,
			label: `Lazy: ${toolName}`,
			description: `Lazy stub for ${toolName}. Loads package '${owner}' on first use, then activates the real tool. Call again after activation if needed.`,
			parameters: Type.Object({
				_lazy: Type.Optional(Type.String({ description: "Ignored. Present so the tool is valid before load." })),
			}, { additionalProperties: true }),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				const res = await loadByName(pi, rt, owner, ctx);
				if (!res.ok) {
					return {
						content: [{ type: "text", text: `Failed to load '${owner}': ${res.error}` }],
						details: { ok: false, error: res.error },
					};
				}
				const tools = res.tools?.length ? res.tools.join(", ") : "(see package)";
				return {
					content: [
						{
							type: "text",
							text: res.alreadyLoaded
								? `Package '${owner}' already available. Use the real tools now.`
								: `Loaded '${owner}'${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}. Registered tools: ${tools}. Call the real tool again on the next turn.`,
						},
					],
					details: { ok: true, loaded: owner, tools: res.tools ?? [], alreadyLoaded: !!res.alreadyLoaded },
				};
			},
		});
	}
}

function registerEventTriggers(pi: ExtensionAPI, rt: Runtime) {
	const eventMap = new Map<string, string[]>(); // event -> spec names
	for (const entry of rt.entries.values()) {
		if (entry.state !== "pending") continue;
		for (const ev of entry.spec.event ?? []) {
			const list = eventMap.get(ev) ?? [];
			list.push(entry.spec.name);
			eventMap.set(ev, list);
		}
	}

	const loadTriggered = async (names: Iterable<string>, ctx: ExtensionContext) => {
		const limit = rt.config.autoLoadLimit ?? 1;
		let loaded = 0;
		for (const name of new Set(names)) {
			if (loaded >= limit) break;
			const current = rt.sessionCtx ?? ctx;
			const res = await loadByName(pi, rt, name, current);
			if (res.ok && !res.alreadyLoaded) {
				loaded++;
				notifySafe(rt.sessionCtx ?? current, `lazy: auto-loaded ${name}`, "info");
			}
		}
	};

	// before_agent_start combines explicit event owners with keyword matches.
	pi.on("before_agent_start", async (event, ctx) => {
		// Set before the auto guard: the after-start queue must back off during a
		// turn regardless of whether keyword auto-loading is enabled.
		rt.turnActive = true;
		if (!rt.auto) return;
		const prompt = (event.prompt ?? "").toLowerCase();
		const toLoad = new Set<string>();

		for (const name of eventMap.get("before_agent_start") ?? []) {
			toLoad.add(name);
		}

		for (const entry of rt.entries.values()) {
			if (entry.state !== "pending") continue;
			for (const keyword of entry.normalizedKeywords ?? []) {
				if (prompt.includes(keyword)) {
					toLoad.add(entry.spec.name);
					break;
				}
			}
		}

		await loadTriggered(toLoad, ctx);
	});

	for (const [eventName, owners] of eventMap) {
		if (eventName === "before_agent_start") continue;
		try {
			(pi.on as Function)(eventName, async (_event: unknown, ctx: ExtensionContext) => {
				if (rt.auto) await loadTriggered(owners, ctx);
			});
		} catch (err) {
			console.error(`[pi-lazy] unsupported event trigger '${eventName}': ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

async function runAfterStart(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionContext, generation: number) {
	const queue = [...rt.entries.values()]
		.filter((e) => e.state === "pending" && e.spec.lazy === "after-start")
		.sort((a, b) => (a.spec.priority ?? 100) - (b.spec.priority ?? 100));

	const batchSize = rt.config.afterStartBatchSize ?? 1;
	const delayMs = rt.config.afterStartDelayMs ?? 0;
	const adaptive = rt.config.afterStartAdaptiveYield !== false;
	const prefetch = rt.config.afterStartPrefetch !== false;
	const stale = () => rt.queueCancelled || generation !== rt.sessionGeneration;

	for (let i = 0; i < queue.length && !stale(); i += batchSize) {
		await waitWhilePaused(rt, generation);
		if (stale()) return;

		const batch = queue.slice(i, i + batchSize);
		const next = queue.slice(i + batchSize, i + batchSize * 2);
		// Overlap the next slice's imports with this slice's activation. Factory
		// execution below stays strictly serial and in priority order.
		if (prefetch) {
			for (const entry of next) void prefetchQuietly(rt, entry, rt.sessionCtx ?? ctx);
		}

		let blockedMs = 0;
		for (const entry of batch) {
			if (stale()) return;
			// The ctx passed in was captured by session_start before the timer that
			// scheduled this call; if the session was replaced/reloaded in that gap
			// (or between iterations here), rt.sessionCtx already points at the fresh one.
			const current = rt.sessionCtx ?? ctx;
			const started = performance.now();
			const res = await loadByName(pi, rt, entry.spec.name, current);
			blockedMs += performance.now() - started;
			if (stale()) return;
			if (!res.ok) {
				notifySafe(rt.sessionCtx ?? current, `lazy: after-start failed ${entry.spec.name}: ${res.error}`, "warning");
			}
		}

		if (i + batchSize < queue.length && !stale()) {
			// Give the UI back at least as much time as the slice took from it,
			// capped so a pathologically slow package cannot stall the whole queue.
			const yieldMs = adaptive
				? Math.max(delayMs, Math.min(Math.round(blockedMs), MAX_ADAPTIVE_YIELD_MS))
				: delayMs;
			await sleep(yieldMs);
		}
	}
	refreshStatus(pi, rt, rt.sessionCtx ?? ctx);
}

function listLines(rt: Runtime): string[] {
	const lines: string[] = [];
	const order = ["pending", "loading", "loaded", "error", "poisoned", "eager"] as const;
	const sorted = [...rt.entries.values()].sort((a, b) => {
		const ai = order.indexOf(a.state as (typeof order)[number]);
		const bi = order.indexOf(b.state as (typeof order)[number]);
		if (ai !== bi) return ai - bi;
		return a.spec.name.localeCompare(b.spec.name);
	});

	for (const e of sorted) {
		const mode = e.spec.lazy === false ? "eager" : e.spec.lazy === "after-start" ? "after-start" : "on-demand";
		const ms = e.loadMs != null ? ` ${e.loadMs}ms` : "";
		const err = e.error ? ` — ${e.error}` : "";
		const ready = e.moduleLazyReady ? "" : e.state === "eager" && isManagedLazy(e.spec) ? " (migrate+restart needed)" : "";
		lines.push(`${e.state.padEnd(8)} ${e.spec.name.padEnd(16)} ${mode.padEnd(12)} ${e.spec.source}${ms}${ready}${err}`);
	}
	return lines;
}

export function createPiLazy(pi: ExtensionAPI, agentDir = getAgentDir()) {
	const config = loadConfig(agentDir);
	const catalogStarted = performance.now();
	const rt: Runtime = {
		config,
		entries: buildCatalog(config, agentDir),
		auto: config.auto !== false,
		afterStartQueued: false,
		status: "lazy …",
		profile: [],
		queueCancelled: false,
		sessionGeneration: 0,
		restartRequired: false,
		turnActive: false,
		resumeWaiters: [],
	};
	recordTiming(rt, "catalog", catalogStarted);
	registerStubs(pi, rt);
	registerEventTriggers(pi, rt);

	const endTurn = () => {
		rt.turnActive = false;
		drainResumeWaiters(rt);
	};
	// agent_settled is the later of the two; agent_end covers hosts that never
	// settle (aborted or errored turns). Both are idempotent.
	try {
		pi.on("agent_end", () => {
			endTurn();
		});
		pi.on("agent_settled", () => {
			endTurn();
		});
	} catch (err) {
		// An older host without these events simply never pauses the queue.
		console.error(`[pi-lazy] turn-end events unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}

	pi.on("session_start", async (event, ctx) => {
		rt.sessionGeneration++;
		const generation = rt.sessionGeneration;
		rt.sessionCtx = ctx;
		rt.queueCancelled = false;
		rt.turnActive = false;
		// Waiters parked by the previous session are now stale; release them so
		// they exit on their generation check.
		drainResumeWaiters(rt);
		refreshStatus(pi, rt, ctx);
		ensureManagerCompat(agentDir, rt);
		ensureFooterCompat(agentDir, rt);

		const needsMigrate = [...rt.entries.values()].some(
			(e) => isManagedLazy(e.spec) && !e.moduleLazyReady,
		);
		if (needsMigrate && event.reason === "startup") {
			const line = "pi-lazy: run /lazy migrate then restart for true module-lazy";
			if (rt.config.bootQuiet !== false) lazyLog(agentDir, line);
			else ctx.ui.notify(line, "info");
		}

		rt.afterStartQueued = true;
		// VeryLazy: yield so first paint / prompt isn't blocked. A generation token
		// makes older scheduled work harmless if sessions change in the meantime.
		const initialDelayMs = rt.config.afterStartInitialDelayMs ?? DEFAULT_AFTER_START_INITIAL_DELAY_MS;
		setTimeout(() => {
			void runAfterStart(pi, rt, ctx, generation)
				.catch((err) => {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[pi-lazy] after-start queue failed: ${message}`);
					notifySafe(rt.sessionCtx, `lazy: after-start queue failed: ${message}`, "warning");
				})
				.finally(() => {
					if (generation === rt.sessionGeneration) rt.afterStartQueued = false;
				});
		}, initialDelayMs);
	});

	pi.on("session_shutdown", () => {
		rt.sessionGeneration++;
		rt.sessionCtx = undefined;
		rt.afterStartQueued = false;
		rt.queueCancelled = true;
		rt.turnActive = false;
		// Release parked slices so they observe the cancellation instead of
		// holding their timers until the pause failsafe fires.
		drainResumeWaiters(rt);
	});

	pi.registerCommand("lazy", {
		description: "LazyVim-style extension manager (list|load|disable|enable|rescue|snapshot|restore|delete|migrate|auto|init|scan|status|quiet|doctor)",
		getArgumentCompletions: (prefix) => {
			const sub = ["status", "list", "load", "migrate", "auto", "init", "scan", "disable", "enable", "rescue", "restore", "snapshot", "delete", "config", "quiet", "profile", "doctor"];
			const items = [...sub, "auto on", "auto off"];

			// `/lazy load <name>` — the runtime catalog. `load` needs a name the loader
			// knows, which is the loaded/pending table, not the roster.
			for (const n of rt.entries.keys()) items.push(`load ${n}`);

			// `/lazy enable|disable <name>` — the roster, so the packages offered while
			// typing are the same set the command accepts. Reading the stored file keeps
			// this synchronous; without it the roster is rebuilt from both configs on
			// every keystroke.
			const roster = loadRoster(agentDir);
			for (const e of roster.all) {
				items.push(`enable ${e.name}`, `disable ${e.name}`);
			}

			// `/lazy restore|delete <name>` — a snapshot name, not a package name.
			for (const s of snapshotList(agentDir)) {
				items.push(`restore ${s.name}`, `delete ${s.name}`);
			}

			const mapped = items.map((v) => ({ value: v, label: v }));
			const filtered = mapped.filter((i) => i.value.startsWith(prefix) || i.value.includes(prefix));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const [head, ...rest] = raw.split(/\s+/);
			const sub = (head || "status").toLowerCase();

			if (sub === "status" || sub === "") {
				const lines = [
					formatStatus(rt),
					`auto: ${rt.auto ? "on" : "off"}`,
					`config: ${getLazyConfigPath(agentDir)}`,
					"",
					...listLines(rt),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "list") {
				ctx.ui.notify(listLines(rt).join("\n") || "no specs", "info");
				return;
			}

			if (sub === "config") {
				ctx.ui.notify(getLazyConfigPath(agentDir), "info");
				return;
			}

			if (sub === "quiet") {
				const arg = (args ?? "").trim().toLowerCase();
				if (arg === "on" || arg === "off") {
					rt.config.bootQuiet = arg === "on";
					try {
						saveConfig(rt.config, agentDir);
						ctx.ui.notify(`lazy bootQuiet ${arg === "on" ? "on (routine notices -> logs/pi-lazy.log)" : "off (notices back in chat)"}`, "info");
					} catch (err) {
						ctx.ui.notify(`failed to save config: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}
				ctx.ui.notify(
					`lazy bootQuiet is ${rt.config.bootQuiet !== false ? "on" : "off"} (usage: /lazy quiet on|off; failures always surface)`,
					"info",
				);
				return;
			}

			if (sub === "profile") {
				const lines = rt.profile.length
					? rt.profile.map((item) => `${item.label.padEnd(24)} ${item.ms.toFixed(1)}ms`)
					: ["no timings recorded"];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "scan" || sub === "s") {
				try {
					scanIntoConfig(pi, rt, ctx, agentDir);
				} catch (err) {
					ctx.ui.notify(`scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (sub === "init") {
				// init = scan + migrate.
				//
				// A spec list on its own does nothing: migrateSettings is what turns
				// `lazy: true` into `extensions: []` in settings.json, which is the
				// only thing that actually defers a package's extension factory.
				// Requiring two commands made a half-done setup the default outcome,
				// and the failure mode is silent — the config that exists to speed Pi
				// up leaves packages eager. So init performs both halves.
				//
				// Old init overwrote lazy.json with defaultConfig(), dropping every
				// tuned spec; losing specs made migrate stop managing those packages,
				// which is how a `/lazy init` could make startup slower.
				try {
					const scanLines = scanIntoConfig(pi, rt, ctx, agentDir);
					const result = migrateSettings(agentDir);
					const roster = refreshRoster(agentDir);
					rt.restartRequired = true;

					const lines: string[] = [...scanLines, "", "── migrate ──"];
					if (!result.ok) {
						lines.push(`migrate failed: ${result.error}`);
					} else {
						lines.push(`settings → ${result.settingsPath}`);
						if (result.changed.length > 0) {
							lines.push(`made lazy (${result.changed.length}): ${result.changed.join(", ")}`);
						} else {
							lines.push("nothing to change in settings.json — already in sync.");
						}
						if (result.skipped.length > 0) {
							lines.push(`skipped (${result.skipped.length}): ${result.skipped.join(", ")}`);
						}
						lines.push("Reload or restart Pi to apply it.");
					}
					lines.push("", `── roster ──`, `${roster.all.length} packages recorded for /lazy disable and /lazy enable → ${rosterPath(agentDir)}`);

					// A snapshot replaces settings.packages wholesale, so a package added
					// today is missing from every snapshot taken yesterday — and restoring
					// one silently deregisters it. Fold the new packages in while we are
					// here, since this is the command that discovered them.
					const synced = mergeLiveIntoSnapshots(agentDir);
					if (synced.error) {
						lines.push("", "── snapshots ──", synced.error);
					} else if (synced.updated.length > 0) {
						lines.push("", `── snapshots ──`, `updated ${synced.updated.length}: ${synced.updated.join(", ")}`);
					}

					ctx.ui.notify(lines.join("\n"), result.ok ? "info" : "warning");
				} catch (err) {
					ctx.ui.notify(`failed to initialize config: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (sub === "auto") {
				const mode = (rest[0] ?? "").toLowerCase();
				if (mode === "on" || mode === "off") {
					const previous = rt.auto;
					try {
						rt.auto = mode === "on";
						rt.config.auto = rt.auto;
						saveConfig(rt.config, agentDir);
						ctx.ui.notify(`lazy auto ${mode}`, "info");
					} catch (err) {
						rt.auto = previous;
						rt.config.auto = previous;
						ctx.ui.notify(`failed to save config: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}
				ctx.ui.notify(`lazy auto is ${rt.auto ? "on" : "off"} (usage: /lazy auto on|off)`, "info");
				return;
			}

			if (sub === "migrate") {
				const result = migrateSettings(agentDir);
				if (!result.ok) {
					ctx.ui.notify(`migrate failed: ${result.error}`, "error");
					return;
				}

				const lines = [
					result.changed.length ? `updated: ${result.changed.join(", ")}` : "no package changes needed",
					result.skipped.length ? `already lazy: ${result.skipped.join(", ")}` : "",
					result.added.length ? `added: ${result.added.join(", ")}` : "",
					result.backupPath ? `backup: ${result.backupPath}` : "",
					"Restart pi to apply module-lazy (extensions filtered to []).",
				].filter(Boolean);
				ctx.ui.notify(lines.join("\n"), "info");
				if (result.changed.length > 0) rt.restartRequired = true;
				refreshStatus(pi, rt, ctx);
				return;
			}


			if (sub === "delete") {
				const target = rest.join(" ").trim();
				if (!target) {
					// Bare `delete` lists what can be deleted. `delete` is destructive and
					// its argument is a snapshot name, not a package name, so showing the
					// candidates is the only way to use it without memorising the directory.
					const listed = snapshotList(agentDir);
					ctx.ui.notify(
						listed.length === 0
							? `no snapshots saved — nothing to delete\n(storage: ${snapshotDir(agentDir)})`
							: ["saved snapshots:", ...listed.map((s) => `  ${s.name}  (${s.specCount} specs, ${s.packageCount} packages, ${s.savedAt})`), "", "usage: /lazy delete <name>"].join("\n"),
						"info",
					);
					return;
				}
				const deleted = snapshotDelete(agentDir, target);
				if (!deleted.ok) {
					ctx.ui.notify(`delete failed: ${deleted.error}`, "error");
					return;
				}
				ctx.ui.notify(`deleted snapshot "${target}"`, "info");
				return;
			}

			if (sub === "snapshot" || sub === "snap") {
				const snapshotName = rest.join(" ").trim();
				if (!snapshotName) {
					// Bare `/lazy snapshot` lists what is saved — the only sensible
					// reading now that save/restore are flat subcommands.
					const listed = snapshotList(agentDir);
					ctx.ui.notify(
						listed.length === 0
							? `no snapshots saved — create one with /lazy snapshot <name>\n(storage: ${snapshotDir(agentDir)})`
							: ["saved snapshots:", ...listed.map((s) => `  ${s.name}  (${s.specCount} specs, ${s.packageCount} packages, ${s.savedAt})`), "", `storage: ${snapshotDir(agentDir)}`].join("\n"),
						"info",
					);
					return;
				}
				const result = snapshotSave(agentDir, snapshotName);
				if (!result.ok) {
					ctx.ui.notify(`snapshot failed: ${result.error}`, "error");
					return;
				}
				ctx.ui.notify(
					[
						`saved snapshot "${snapshotName}" — ${result.specCount} specs + ${result.packageCount} settings packages`,
						`  → ${result.path}`,
						result.overwrote ? `  overwrote previous (kept as ${result.previous})` : "",
					].filter(Boolean).join("\n"),
					"info",
				);
				return;
			}

			if (sub === "restore") {
				const snapshotName = rest.join(" ").trim();
				if (!snapshotName) {
					ctx.ui.notify("usage: /lazy restore <name>   ·   /lazy snapshot   to list saved snapshots", "warning");
					return;
				}
				const result = snapshotRestore(agentDir, snapshotName);
				if (!result.ok) {
					ctx.ui.notify(`restore failed: ${result.error}`, "error");
					return;
				}
				rt.config = loadConfig(agentDir);
				refreshStatus(pi, rt, ctx);
				ctx.ui.notify(
					[
						`restored snapshot "${snapshotName}" — scheme replaced (not merged)`,
						`  lazy.json:     ${result.specCount} specs`,
						`  settings.json: ${result.packageCount} packages registered`,
						`  migrate:       ${result.migrated} entr${result.migrated === 1 ? "y" : "ies"} updated`,
						result.added.length ? `  new specs:      ${result.added.join(", ")}` : "",
						result.removed.length ? `  no longer registered: ${result.removed.join(", ")}` : "",
						"  node_modules untouched — `pi install npm:<name>` brings any of them back",
						...result.backups.map((b) => `  backup: ${b}`),
						"Not in effect yet — run /reload for the change to take effect.",
					].filter(Boolean).join("\n"),
					"info",
				);
				return;
			}

			if (sub === "rescue" || sub === "panic") {
				const result = rescueNative(agentDir);
				if (!result.ok) {
					ctx.ui.notify(`rescue failed: ${result.error}`, "error");
					return;
				}
				refreshStatus(pi, rt, ctx);

				const lines = ["rescued — every package handed back to native Pi"];
				lines.push(`  lazy.json: ${result.specsCleared} spec${result.specsCleared === 1 ? "" : "s"} cleared (file kept: deleting it would let lazy rebuild its catalog)`);
				if (result.handedBack.length > 0) {
					lines.push(`  settings.json: ${result.handedBack.length} package${result.handedBack.length === 1 ? "" : "s"} restored to eager:`);
					for (const s of result.handedBack) lines.push(`    ${s}`);
				} else {
					lines.push("  settings.json: no lazy-written filters found — nothing to restore");
				}
				if (result.keptOverrides.length > 0) {
					lines.push("  kept explicit entry filters (not written by lazy):");
					for (const s of result.keptOverrides) lines.push(`    ${s}`);
				}
				for (const p of result.backups) lines.push(`  backup: ${p}`);
				lines.push("Not in effect yet — run /reload for the change to take effect.");
				lines.push("To come back: /lazy init (rebuild the catalog) or restore a *.bak.rescue-* file.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "enable" || sub === "en") {
				const name = rest.join(" ").trim();
				if (!name) {
					ctx.ui.notify(formatRoster(loadRoster(agentDir), "enable"), "info");
					return;
				}
				const result = enablePackage(agentDir, name);
				if (!result.ok) {
					ctx.ui.notify(`enable failed: ${result.error}`, "error");
					return;
				}
				refreshStatus(pi, rt, ctx);

				if (result.noop) {
					ctx.ui.notify(`enabled ${name} — already in the loading scheme [${result.mode}], nothing to do`, "info");
					return;
				}
				const lines = [`enabled ${name} — back in the loading scheme`];
				if (result.restoredSpec) lines.push(`  lazy.json: spec restored [${result.mode}]${result.specFrom ? ` from ${basename(result.specFrom)}` : ""}`);
				if (result.restoredEntry) lines.push(`  settings.json: package entry restored${result.entryFrom ? ` from ${basename(result.entryFrom)}` : ""}`);
				lines.push(`  migrate: ${(result.migrated ?? 0) > 0 ? `${result.migrated} entr${result.migrated === 1 ? "y" : "ies"} updated` : "nothing to change"}`);
				if (result.migrateError) lines.push(`  migrate error: ${result.migrateError}`);
				lines.push("  node_modules: untouched — `pi install npm:<name>` if the package itself is gone");
				for (const p of result.backups) lines.push(`  backup: ${p}`);
				lines.push("Not in effect yet — run /reload for the change to take effect.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "disable" || sub === "d") {
				const name = rest.join(" ").trim();
				if (!name) {
					ctx.ui.notify(formatRoster(loadRoster(agentDir), "disable"), "info");
					return;
				}
				const result = disablePackage(agentDir, name);
				if (!result.ok) {
					ctx.ui.notify(`disable failed: ${result.error}`, "error");
					return;
				}
				refreshStatus(pi, rt, ctx);

				if (result.noop) {
					ctx.ui.notify(`disabled ${name} — already out of the loading scheme, nothing to do`, "info");
					return;
				}
				const lines = [`disabled ${name} — removed from the loading scheme`];
				if (result.droppedFromSettings) lines.push("  settings.json: package entry removed");
				else lines.push("  settings.json: no matching package entry (spec only)");
				lines.push("  lazy.json: spec removed");
				lines.push(`  migrate: ${(result.migrated ?? 0) > 0 ? `${result.migrated} entr${result.migrated === 1 ? "y" : "ies"} updated` : "nothing to change (this package is out of settings; migrate only confirms the rest of the catalog)"}`);
				lines.push("  node_modules: untouched — `pi install npm:<name>` brings it back");
				for (const p of result.backups) lines.push(`  backup: ${p}`);
				lines.push("Not in effect yet — run /reload for the change to take effect.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}


			if (sub === "doctor") {
				// 一键：顺手把 pi-extmgr 的兼容补丁补回（幂等，已打过则直接返回）
				ensureManagerCompat(agentDir, rt);
				ctx.ui.notify(runDoctor(agentDir, rt).join("\n"), "info");
				return;
			}

			if (sub === "load" || sub === "l") {
				const name = rest.join(" ").trim();
				if (!name) {
					ctx.ui.notify("usage: /lazy load <name>", "warning");
					return;
				}
				const res = await loadByName(pi, rt, name, ctx);
				if (!res.ok) {
					ctx.ui.notify(`load failed: ${res.error}`, "error");
					return;
				}
				if (res.alreadyLoaded) {
					ctx.ui.notify(`${res.name} already loaded/eager`, "info");
					return;
				}
				ctx.ui.notify(
					`loaded ${res.name}${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}${
						res.tools?.length ? ` — tools: ${res.tools.join(", ")}` : ""
					}`,
					"info",
				);
				return;
			}

			ctx.ui.notify("usage: /lazy [status|list|profile|load <name>|disable <name>|enable <name>|rescue|snapshot <name>|restore <name>|delete <name>|init|scan|migrate|auto on|off|quiet on|off|config]", "warning");
		},
	});

	pi.registerTool({
		name: "lazy_load",
		label: "Lazy Load",
		description:
			"Load a deferred Pi extension package managed by pi-lazy (LazyVim-style). Use when a capability is pending/on-demand (web, mcp, lens, plannotator, context-mode, etc.). Prefer /lazy list names.",
		promptSnippet: "Load a deferred pi-lazy extension package on demand",
		parameters: Type.Object({
			name: Type.String({ description: "Spec name from /lazy list (e.g. web, mcp, lens, plannotator)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const res = await loadByName(pi, rt, params.name, ctx);
			// Serialize a safe, structuredClone-friendly details payload. LoadResult
			// may contain only primitives now, but keeping an explicit allowlist here
			// means a future non-serializable field can never crash the transcript
			// (pi structuredClones tool-result `details`).
			const details = {
				ok: res.ok,
				name: res.name,
				alreadyLoaded: !!res.alreadyLoaded,
				loadMs: res.loadMs ?? null,
				tools: res.tools ?? [],
				commands: res.commands ?? [],
				error: res.error ?? undefined,
			};
			if (!res.ok) {
				return {
					content: [{ type: "text", text: `Failed: ${res.error}` }],
					details,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: res.alreadyLoaded
							? `'${res.name}' already loaded or eager.`
							: `Loaded '${res.name}' in ${res.loadMs ?? "?"}ms. tools=[${(res.tools ?? []).join(", ")}] commands=[${(res.commands ?? []).join(", ")}]`,
					},
				],
				details,
			};
		},
	});
}

export default function piLazy(pi: ExtensionAPI) {
	return createPiLazy(pi, getAgentDir());
}

declare global {
	var __piLazyStatus: string | undefined;
	var __piLazyManagedSources: Set<string> | undefined;
}
