# Changelog

All notable changes to this fork are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How to read this file:
- **Added** — features the fork has that upstream does not.
- **Changed** — behavior that differs from upstream.
- **Fixed** — bugs that were present in upstream and are now resolved.
- **Patches (P1–P11)** — the canonical IDs we use across source, dist, and `LOCAL-PATCHES.md`
  for traceability. New patches get the next number; renumbering never happens.

## 0.6.0 — 2026-10-15

### Added

- **Local extensions under `extensions/` are discoverable.** Pi walks `<agent-dir>/extensions/` and
  loads whatever each folder's manifest declares, so those extensions have no `settings.packages`
  entry and no `extensions` filter — which makes them invisible to this extension and impossible to
  defer. `init` and `scan` now scan `extensions/*/package.json`, read each manifest's `pi.extensions`,
  keep only declarations that resolve to real files, and register each directory **as a package**
  (spec plus a `settings.packages` entry). That registration is what gives the entrypoint a filter,
  and the filter is what actually defers the factory. Folders without a usable manifest are skipped
  rather than guessed at — a bare directory contributes nothing, and a spec for it would produce an
  entry that fails to load forever.
- **`/lazy init` brings every saved snapshot up to the live plugin set.** A snapshot replaces
  `settings.packages` wholesale, so a package installed after the snapshot was taken is simply
  absent from it — and restoring that snapshot deregisters the package, which stops loading with no
  error anywhere. After the catalog merge and migrate, `init` adds whatever spec or package entry
  each snapshot is missing. Additive only — a snapshot never loses anything, and entries already in
  it keep their own `extensions` filter form, since that form is the reason the snapshot exists.
  Schemes therefore stay in step on which plugins exist and differ on when each one loads.
- **`/lazy snapshot <name>`** — save the whole loading scheme under a name. A snapshot captures the
  catalog, its global switches, **and** the `settings.json` package list with each entry's
  `extensions` filter form intact. Catalog-only saving was tried first and is not sufficient:
  `packages` is what Pi registers, and the filter form there (`[]` = module-lazy,
  `["+index.ts"]` = force one entrypoint, absent = eager) decides eager-vs-lazy behaviour that no
  spec edit can reproduce. Snapshots live in `<agent-dir>/lazy-snapshots/<name>.json`; overwriting
  one keeps the previous copy as `.bak-<stamp>`.
- **`/lazy snapshot`** (no argument) lists saved snapshots with spec/package counts and saved-at
  time; **`/lazy delete <name>`** removes one.
- **`/lazy restore <name>`** — switch to a saved snapshot. This is a **replacement, not a merge**:
  restoring a scheme built on `5,6,7,8` over one built on `1,2,3,4` ends with exactly `5,6,7,8`.
  Implemented as three ordered steps — write `settings.packages`, write `lazy.json`, then run
  `migrateSettings`. The first step is load-bearing: without it the old packages stay registered
  and keep loading, so the result is `1,2,3,4,5,6,7,8`. Packages a snapshot omits are reported but
  never deleted from disk; `pi install npm:<name>` brings any of them back. Both files are backed
  up (`*.bak.restore-<stamp>`) before the first write.
- **`/lazy disable <name>`** (alias `d`) — drop a package from the loading scheme by removing its
  catalog spec and its `settings.packages` entry. Deliberately named `disable` rather than
  remove/uninstall: `"extensions": []` does not uninstall anything, because Pi's package manager
  defaults every entry to enabled and applies `+`/`-` overrides on top, so an empty filter list
  simply yields no enabled files while the package stays in `node_modules`. Not a fourth `lazy`
  mode — the three modes decide *when* a catalog member loads, disabling decides whether it is a
  member at all.
- **`/lazy enable <name>`** (alias `en`) — restore a package removed by `/lazy disable`. The spec and
  the settings entry come back from the most recent `*.bak.disable-*` snapshot that still contains
  them, so the original `lazy` / `after-start` / `eager` mode is preserved. A migrate follows so the
  restored mode is translated back into `extensions: []`; without it the entry would be registered
  but eager. `node_modules` is untouched in both directions.
- **`/lazy rescue`** (alias `panic`) — hand every package back to native Pi. Clears the
  `extensions` filters lazy wrote in `settings.packages` and empties the catalog. The catalog file is
  emptied rather than deleted on purpose: `loadConfig()` regenerates a built-in catalog when the file
  is missing, so deleting it would hand control straight back to the extension on next start. Entries
  carrying `+`/`-` filters are left alone — those predate lazy. The escape hatch for a configuration
  broken badly enough that the other subcommands are unusable.
- **Roster file** (`lazy-roster.json`), regenerated by `/lazy init`: every installed package with its
  mode, used by the bare `/lazy enable` and `/lazy disable` listings and by tab completion after those
  subcommands, so the names offered while typing are the names the commands accept.
- Tab completion now offers package names after `enable` / `disable` and snapshot names after
  `restore` / `delete`, not just after `load`.

### Changed

- **Deleting a snapshot is a top-level verb: `/lazy delete <name>`, not `/lazy snapshot delete
  <name>`.** The nested form never worked. It compared the *whole* argument string against the word
  `delete`, so the check only matched when no snapshot name followed — exactly the case where there
  was nothing to delete. `/lazy snapshot delete test` therefore fell through to the save path and
  created a snapshot named `delete test` instead of removing one. Bare `/lazy delete` lists the saved
  snapshots, since the argument is a snapshot name and not a package name.
- **Discovery no longer defaults to `lazy: true`; new specs are added eager (`lazy: false`).**
  `init` discovers what is installed, it does not decide when anything loads. Defaulting to deferred
  meant a single `/lazy init` could silently re-time a whole stack — and if one of the newly deferred
  packages was pi-lazy itself, the manager would take itself out of the session, its filters would
  never be applied, and every package it manages would stop loading. The status quo (eager, which is
  how Pi already had them) is now the default, and deferral is opt-in per package.
- `/lazy enable`, `/lazy disable` and `/lazy restore` now run `/lazy migrate` as their final step, so
  `lazy.json` and `settings.json` always land in the same state. This was the drift behind a class of
  silent no-ops: editing `lazy.json` alone changes intent but not behaviour, because Pi only reads
  `settings.packages`. Every report gained a `migrate:` line that distinguishes a real translation
  from a no-op, so it is visible when a command changed nothing.
- Repeating a verb is no longer an error. `disable` on an already-disabled package and `enable` on an
  already-enabled one report the state they found (`already … , nothing to do`) and succeed. Both verbs
  accept the same full roster, so either request is a legitimate one to make.

### Notes

- No reload wrapper was added. Pi already exposes `/reload`, and a second entry point for the same
  operation is a naming collision waiting to happen; every new command points at Pi's own.
- Keep pi-lazy's own spec at `lazy: false`. It is the mechanism that defers everything else, so it
  cannot be deferred by itself; `lazy: true` on this package is a self-lockout, not a preference.

## 0.5.0 — 2026-10-15

Minor bump because `/lazy init` changed observable behavior (it no longer replaces the catalog),
which is a breaking change for anyone who used it as a reset. Released together with the tree
consolidation: the live extension and this repository are now the same directory.

### Added

- **`/lazy scan`** (alias `/lazy s`) — merges packages present in `settings.json` but missing from
  the catalog into `lazy.json`, without touching `settings.json`. Existing specs are kept verbatim;
  only genuinely new packages get an entry. Idempotent: running it twice adds nothing.
- **`/lazy init` now performs the migrate step.** One command leaves the catalog merged *and*
  applied, instead of leaving a half-done setup whose specs exist but do nothing.

### Changed

- **`/lazy init` is incremental and no longer destructive.** It previously called
  `saveConfig(defaultConfig())`, replacing the whole file with the built-in catalog. Any spec the
  user had tuned was silently dropped. Because `/lazy migrate` reads that catalog to decide which
  `settings.packages` entries become `"extensions": []`, dropping specs silently un-lazy'd those
  packages — so a `/lazy init` could make Pi *slower* to start, the opposite of what the config is
  for. `init` now merges instead of replacing, and always writes a timestamped backup when the file
  already existed.
- Discovery is scoped to `settings.json`'s `packages` array. Packages merely present in
  `node_modules` are never given specs: Pi would not load them anyway, so a spec would be inert and
  would misreport them as managed in `/lazy list`. This mirrors migrate's Guard 1.
- Packages whose `settings.packages` entry carries explicit `extensions` filters (e.g.
  `["+index.ts"]` or `["-extensions/goal.ts"]`) are left alone. Those already state an intent, and
  inferring `cmd`/`keywords` for an unknown extension would be guesswork — this also means disabled
  packages marked with exclusion filters are never re-enabled by `init`.
- Repository layout: `src/` now ships with the live extension, so behavior is changed in TypeScript
  and rebuilt with `npm run build`. The separate `pi-lazy-fork/` copy this used to be mirrored from
  is gone; `extensions/pi-lazy` holds `src/`, `dist/`, and the git history together.

### Notes for maintainers

- `dist/index.js` is a bundle of `src/*.ts`. Rebuild with `npm run build` after any `src/` change;
  editing only `src/` has no effect and raises no error.
- Never place backups or scratch copies under `agent/extensions/` — Pi loads every package found
  there regardless of directory name, and a second copy of pi-lazy collides with the first on tool
  registration. Keep backups outside that directory.

## 0.4.0 — 2026-10-15

Forked from upstream `@rahularya01/pi-lazy` v0.3.1 (commit `fd4910a`, 2026-08-27). The upstream
repo is unmaintained; this is the first release of the maintained fork `manjughosa/pi-lazy`.
All upstream 0.3.1 behavior is preserved; the changes below are additive/compat fixes verified
against the live extension.

### Diff vs upstream v0.3.1

| Area | Upstream 0.3.1 | This fork 0.4.0 |
|---|---|---|
| Maintenance | unmaintained since 2026-08-27 | tracked releases, every change logged here |
| `/lazy doctor` | absent | scans settings + lazy.json + runtime state |
| `pi-extmgr` interaction | treats lazy `[]` as "all disabled" | `ensureManagerCompat` honors lazy-managed sources |
| `pi-powerline-footer` interaction | blocks welcome on slow `getRecentSessions` | `ensureFooterCompat` short-circuits the slow path |
| `typebox` module collision | yes (`Host-provided package 'typebox'...` warning) | peer-dependency only, no warning |
| Built-in default catalog | 12 entries, 7 are ghosts (never load) | 5 entries, all live |
| `auto` default | `true` (eager after-start queue) | `false` (opt-in) |
| `migrate` behavior | pushes phantom entries + clobbers exclusions | three guards — only touches registered specs, yields to `-`/`!` markers, skips already-lazy |
| Status line | rendered twice (top + bottom) | rendered once (top, via persona-loader) |
| `globalThis.__piLazyStatus` | absent | published for persona-loader + extmgr |
| `globalThis.__piLazyManagedSources` | absent | published for extmgr compat |

### Added
- `/lazy doctor` — scans lazy.json + settings.json + runtime state for misconfigurations
  (invalid `lazy` values, duplicate settings entries, un-migrated strings, extension-dir
  double registration, specs with no triggers, failed/poisoned entries, after-start queue
  that ended with pending loads).
- `ensureManagerCompat` on every session_start: patches pi-extmgr so entries with
  `extensions: []` that are lazy-managed are treated as *deferred*, not disabled, by
  consulting `globalThis.__piLazyManagedSources` (idempotent — skips once patched).
- `ensureFooterCompat` on every session_start: patches pi-powerline-footer so the welcome
  overlay/header renders immediately instead of blocking on `getRecentSessions` for the
  currently-writing session log (idempotent — skips once patched).
- `config.managerCompat` (default true) / `config.footerCompat` (default true) to disable
  either patch.
- `config.auto` now defaults to `false` — opt-in via `lazy_auto: true` or `/lazy auto on`.
- Patches P1–P11: see [LOCAL-PATCHES.md](LOCAL-PATCHES.md) for the canonical source-anchored
  record (one entry per patch, with the exact diff and rationale).

### Changed
- `migrate` guards (P5): never fabricate `settings.packages` entries for specs that are not
  registered (upstream pushed phantom `{source, extensions: []}`), yield to entries carrying
  exclusion markers (`-` / `!` filters — that is extmgr's own disable state), and leave
  already-lazy `[]` entries untouched.
- Default catalog (P2): removed always-on provider bridges (grok-cli/antigravity/cursor) and
  packages that were not actually installed in the user's environment (paster/context-mode/
  lens/plannotator) — those were being resolved but never loaded, adding phantom entries.
- Status rendering (P6/P7/P10): pi-lazy no longer calls `ui.setStatus`; the top status line
  is rendered by persona-loader from `globalThis.__piLazyStatus` (set on every refresh).
  `globalThis.__piLazyManagedSources` is also published for the extmgr compat patch.

### Fixed
- `typebox` Host-provided package warning (P1).
- pi-extmgr showing every lazy-managed package as "disabled" (P9).
- pi-powerline-footer status line appearing twice (P10).
- `migrate` clobbering entries that extmgr had explicitly disabled via `-...` / `!...`
  filters (P5 guard 2).
- `migrate` clobbering already-lazy `[]` entries (P5 guard 3).
- `migrate` pushing `{source, extensions: []}` for specs that were never even registered
  in settings (P5 guard 1).

### Acknowledgments
- [@Rahularya01](https://github.com/Rahularya01) — original author of v0.1.x through v0.3.1.
  The license and copyright are preserved verbatim per the MIT terms.
- The pi-extmgr and pi-powerline-footer maintainers for the auto-patch surface that makes
  `ensureManagerCompat` / `ensureFooterCompat` possible.

## 0.3.1
