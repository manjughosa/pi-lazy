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

## [Unreleased]

(none yet — the next patch level will be 0.4.1 for any hotfixes.)

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
