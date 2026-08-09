## Unreleased

- **REDESIGNED**: WebUI rebuilt as a multi-page (tabbed) Material Design 3 expressive layout — Applications, Profiles, and Settings now each live on their own page with a persistent bottom navigation bar, instead of one long scrolling page
- **NEW**: Applications page has a User Apps / System Apps filter (backed by `pm list packages -3` / `-s`) and a sort menu (blocked-first, name A–Z, name Z–A)
- **NEW**: "Block All" / "Unblock All" now act on the currently filtered + searched app list, so you can e.g. filter to System Apps and block just those, or search "google" and block only matching apps
- **NEW**: Profiles moved to their own page as a tappable list (with an always-available "No Profile" entry) instead of a `<select>` dropdown
- **NEW**: Settings page consolidates Language, Backup & Restore (import/export), a Danger Zone "Reset All Rules" action (with confirmation), and an About section showing the live module version
- **IMPROVED**: Per-app row now shows a small badge with the number of custom-blocked domains directly on the domain icon
- **IMPROVED**: Nav bar shows live badge counts (blocked app count, saved profile count)
- **FIXED**: Failed `netswitch` commands (e.g. permission errors) previously still updated the UI as if they'd succeeded, since errors were swallowed instead of propagated — toggles, domain edits, and profile actions now correctly roll back and report failure
- **FIXED**: Saving/deleting a profile had no error handling at all; a failed write to `profiles.json` would silently show a false "success" toast
- **FIXED**: Language selection modal never indicated which language was currently active
- **FIXED**: Removed a duplicate/invalid `type` attribute on both `<script>` tags
- **IMPROVED**: Deduplicated the translation key-resolution logic in `language.js`; added support for translating `title` attributes (`data-i18n-title`)
- **IMPROVED**: App avatar initials are now derived from the more distinctive segment of the package name (e.g. `com.whatsapp` → "W")
- **REMOVED**: Orphaned/unused translation keys (`close`, `back_button`, `select_profile`, `backup_manager`)

## 1.4

- **NEW**: Separate per-app Wi-Fi and mobile data switches, instead of a single connectivity toggle
- **NEW**: Per-app custom domain/IP blocking with automatic periodic DNS refresh
- **REDESIGNED**: WebUI rebuilt in Material Design 3 expressive style
- **IMPROVED**: WebUI now drives the bundled `netswitch` CLI instead of duplicating iptables logic, removing a class of state-sync bugs
- **IMPROVED**: Firewall rules now live in a dedicated `NETSWITCH` chain that is rebuilt atomically, fixing stale/duplicate rule leaks
- **FIXED**: `uninstall.sh` removed the wrong config directory
- **FIXED**: Dead/unused toast markup and broken CI copy step removed

## 1.3

- **NEW**: Added Profiles System for app isolation management
- **IMPROVED**: Enhanced UI with profile management controls
- **IMPROVED**: Better user feedback with status indicators
- **NEW**: Added profile backup system

## 1.2

- Fix wrong UID fetch
- Automatically remove uninstalled apps from isolated.json
- Refactor and Migrate WebUI to Vite

---
**SHA256**: `4d79e6d6b27c3e5f7f7b319d65f0cfd14d395c57e750b02f9e3b405f0f9a91f8`
