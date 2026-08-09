BASE_DIR="/data/adb/.config/net-switch"
mkdir -p "$BASE_DIR/domains"
[ -f "$BASE_DIR/wifi.json" ] || echo "[]" >"$BASE_DIR/wifi.json"
[ -f "$BASE_DIR/mobile.json" ] || echo "[]" >"$BASE_DIR/mobile.json"

if [ "$KSU" = "true" ] || [ "$APATCH" = "true" ]; then
	rm "$MODPATH/action.sh"
	touch "$MODPATH/skip_mount"
	manager_paths="/data/adb/ap/bin /data/adb/ksu/bin"
	for dir in $manager_paths; do
		if [ -d "$dir" ]; then
			echo "- creating symlink in $dir"
			ln -sf /data/adb/modules/net-switch/system/bin/netswitch "$dir/netswitch"
		fi
	done
fi

set_perm_recursive "$MODPATH/system" 0 0 0755 0755
