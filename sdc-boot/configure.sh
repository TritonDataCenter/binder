#!/usr/bin/bash
#
# Copyright (c) 2012 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/nodejs/bin:/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

echo "Enabling service zookeeper"
/usr/sbin/svcadm disable application/zookeeper
/usr/sbin/svcadm enable application/zookeeper

echo "Enabling service binder"
/usr/sbin/svcadm disable application/binder
/usr/sbin/svcadm enable application/binder

exit 0
