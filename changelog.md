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
