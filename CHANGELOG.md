# Changelog

## 0.4.0 (fork: pi-lazy)

Community-maintained fork of @rahularya01/pi-lazy. Identity: package name `pi-lazy`,
repository manjughosa/pi-lazy. All upstream 0.3.1 behavior is preserved; the changes below
are additive/compat fixes verified against the live extension.

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

### Changed
- `migrate` guards (P5): never fabricate `settings.packages` entries for specs that are not
  registered (upstream pushed phantom `{source, extensions: []}`), yield to entries carrying
  exclusion markers (`-` / `!` filters — that is extmgr's own disable state), and leave
  already-lazy `[]` entries untouched.
- `config.auto` now defaults to `false` (P3) — after-start queue no longer runs
  automatically; use `lazy_auto: true` in config or `/lazy auto on`.
- Default catalog (P2): removed always-on provider bridges (grok-cli/antigravity/cursor) and
  packages that were not actually installed in the user's environment (paster/context-mode/
  lens/plannotator) — those were being resolved but never loaded, adding phantom entries.
- Status rendering (P6/P7/P10): pi-lazy no longer calls `ui.setStatus`; the top status line
  is rendered by persona-loader from `globalThis.__piLazyStatus` (set on every refresh).
  `globalThis.__piLazyManagedSources` is also published for the extmgr compat patch.

## 0.3.1
