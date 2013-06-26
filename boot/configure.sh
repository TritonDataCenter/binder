#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-

set -o xtrace

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
SVC_ROOT=/opt/smartdc/binder

source ${DIR}/scripts/util.sh
source ${DIR}/scripts/services.sh

export PATH=$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH
export ZOO_LOG4J_PROP=TRACE,CONSOLE


function manta_setup_zookeeper {
    manta_add_logadm_entry "zookeeper" "/var/log"

    svccfg import /opt/local/share/smf/zookeeper-server/manifest.xml || \
	fatal "unable to import ZooKeeper"
    svcadm enable zookeeper || fatal "unable to start ZooKeeper"
}


# Mainline

echo "Running common setup scripts"
manta_common_presetup

echo "Adding local manifest directories"
manta_add_manifest_dir "/opt/smartdc/binder"

manta_common_setup "binder"

echo "Setting up ZooKeeper"
manta_setup_zookeeper

manta_ensure_zk

echo "Installing binder"
svccfg import $SVC_ROOT/smf/manifests/binder.xml || \
    fatal "unable to import binder"
svcadm enable binder || fatal "unable to start binder"

manta_common_setup_end

exit 0
