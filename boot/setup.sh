#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
SVC_ROOT=/opt/smartdc/binder

export PATH=$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH

# ZK-related common setup.
source /opt/smartdc/boot/zk_common.sh

zk_common_delegated_dataset
zk_common_log_rotation

if [[ -n $(mdata-get sdc:tags.manta_role) ]]; then
    export FLAVOR="manta"
else
    export FLAVOR="sdc"
fi

if [[ ${FLAVOR} == "manta" ]]; then
    source ${DIR}/scripts/util.sh
    source ${DIR}/scripts/services.sh

    export ZOO_LOG4J_PROP=TRACE,CONSOLE

    echo "Running common setup scripts"
    manta_common_presetup

    echo "Adding local manifest directories"
    manta_add_manifest_dir "/opt/smartdc/binder"

    manta_common_setup "binder"

    echo "Setting up ZooKeeper"
    # manta_setup_zookeeper
    manta_add_logadm_entry "zookeeper" "/var/log/zookeeper" "exact"

    zk_common_import ${SVC_ROOT}

    echo "Installing binder"
    svccfg import ${SVC_ROOT}/smf/manifests/binder.xml
    # || \
    #     fatal "unable to import binder"
    # svcadm enable binder || fatal "unable to start binder"

    manta_common_setup_end

else # FLAVOR == "sdc"

    # Include common utility functions (then run the boilerplate)
    source /opt/smartdc/boot/lib/util.sh
    CONFIG_AGENT_LOCAL_MANIFESTS_DIRS="/opt/smartdc/binder"
    sdc_common_setup

    # Cookie to identify this as a SmartDC zone and its role
    mkdir -p /var/smartdc/binder
    mkdir -p /opt/smartdc/etc

    echo "Setting up zookeeper."
    zk_common_import ${SVC_ROOT}

    echo "Importing binder SMF manifest."
    svccfg import /opt/smartdc/binder/smf/manifests/binder.xml \
        || fatal "unable to import binder manifest"
    svcadm enable binder || fatal "unable to start binder"

    # Log rotation.
    sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
    sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
    sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
    sdc_log_rotation_add binder /var/svc/log/*binder*.log 1g
    sdc_log_rotation_add zookeeper /var/log/zookeeper/zookeeper.log 1g
    sdc_log_rotation_setup_end

    # All done, run boilerplate end-of-setup
    sdc_setup_complete

fi

exit 0
