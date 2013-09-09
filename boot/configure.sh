#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/nodejs/bin:/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

#
# XXX in the future this should come from SAPI and we should be pulling out
# the "application" that's the parent of this instance. (see: SAPI-173)
#
if [[ -n $(mdata-get sdc:tags.manta_role) ]]; then
    export FLAVOR="manta"
else
    export FLAVOR="sdc"
fi

if [[ ${FLAVOR} == "sdc" ]]; then

    echo "Enabling service zookeeper"
    /usr/sbin/svcadm disable application/zookeeper
    /usr/sbin/svcadm enable application/zookeeper

    echo "Enabling service binder"
    /usr/sbin/svcadm disable application/binder
    /usr/sbin/svcadm enable application/binder

fi

exit 0
