#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

#
# The "BINDER_PROCS_PER_ZONE" SAPI property allows the operator to increase the
# number of instances of the binder SMF service created for this zone.  Cap
# this value at a reasonable maximum of 32 processes.
#
MANTA_BINDER_MAX_PROCS=32

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

    echo "Adding log rotation rules"
    for (( i = 1; i <= MANTA_BINDER_MAX_PROCS; i++ )); do
        ii=$(( 5300 + i ))
        #
        # If there are multiple binder processes configured, there will be
        # multiple log files.  We need to upload each one with a distinct name,
        # so we add the instance number before the zone UUID.
        #
        if ! logadm -w "binder-$ii" -C 48 -c -p 1h \
          -t "/var/log/manta/upload/binder_$ii.\$nodename_%FT%H:00:00.log" \
          "/var/svc/log/*binder-$ii.log"; then
            fatal "could not add log rotation rule for instance $inum"
        fi
    done
    if ! manta_add_logadm_entry 'binder-balancer'; then
        fatal" could not add log rotation rule for balancer"
    fi

    #
    # In order to arrange for specific log rotation behaviour, we opt out of
    # the current logadm configuration step provided by "manta_common_setup".
    #
    skip_logrotate=1
    manta_common_setup "binder" "$skip_logrotate"

    echo "Setting up ZooKeeper"
    # manta_setup_zookeeper
    manta_add_logadm_entry "zookeeper" "/var/log/zookeeper" "exact"

    zk_common_import ${SVC_ROOT}

    echo "Installing binder socket directory SMF service"
    if ! svccfg import ${SVC_ROOT}/smf/manifests/mksockdir.xml; then
        fatal "unable to import binder socket directory service"
    fi

    echo "Installing binder balancer SMF service"
    if ! svccfg import ${SVC_ROOT}/smf/manifests/binder-balancer.xml; then
        fatal "unable to import binder balancer service"
    fi

    echo "Installing binder SMF service"
    if ! svccfg import ${SVC_ROOT}/smf/manifests/multi-binder.xml; then
        fatal "unable to import binder service"
    fi

    #
    # Determine the desired number of binder instances for this zone.
    #
    nprocs=1
    if ! res=$(json -f $METADATA BINDER_PROCS_PER_ZONE); then
        fatal "unable to load metadata JSON"
    fi
    if [[ -n $res && $res -gt 1 && $res -le $MANTA_BINDER_MAX_PROCS ]]; then
        nprocs=$res
    fi

    echo "Configuring instances of binder SMF service"
    if ! /opt/smartdc/binder/lib/smf_adjust -s 'svc:/manta/application/binder' \
      -b binder -B 5301 -i $nprocs; then
        fatal "unable to configure instances of binder SMF service"
    fi

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
    svccfg import /opt/smartdc/binder/smf/manifests/single-binder.xml \
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
