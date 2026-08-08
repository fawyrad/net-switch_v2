#!/bin/sh

iptables -F NETSWITCH 2>/dev/null
ip6tables -F NETSWITCH 2>/dev/null
rm -rf /data/adb/.config/net-switch
rm -f /data/adb/ap/bin/netswitch
rm -f /data/adb/ksu/bin/netswitch
