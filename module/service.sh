#!/bin/sh

until [ "$(getprop sys.boot_completed)" = "1" ] && [ -f /data/system/packages.list ]; do
	sleep 1
done

netswitch apply >>/dev/kmsg 2>&1

(
	while true; do
		sleep 900
		netswitch apply >>/dev/kmsg 2>&1
	done
) &
