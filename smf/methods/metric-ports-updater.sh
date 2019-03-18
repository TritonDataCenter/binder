#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2019 Joyent, Inc.
#

#
# This script updates the zone's "metricPorts" mdata value with the current
# ports on which the binder instances are exposing metrics, with the intent of
# keeping the mdata value in sync with the ports determined by the smf_adjust
# utility. To this end, this script's SMF manifest is configured to run the
# script every time a binder service is refreshed or restarted. smf_adjust can
# also be made to restart this service by passing the instance FMRI,
# 'svc:/manta/application/metric-ports-updater', as the argument to the -r flag.
#
# Note that this script does not get run automatically if a binder instance is
# manually disabled or enters maintenance unexpectedly. In this case, it's ok if
# the instance's metric port remains in the mdata -- cmon-agent gracefully
# handles the scraping of closed ports. The next time the script runs, the
# superfluous port will be removed from the mdata.
#

SVC_NAME=binder

set -o errexit
set -o pipefail
set -o xtrace

pattern="svc:/manta/application/binder:binder-"

if ! all=$(svcs -aHo sta,nsta,fmri); then
    printf 'ERROR: svcs failure\n' >&2
    exit 1
fi

insts=()
while read sta nsta fmri; do
    if [[ "$fmri" != "$pattern"* ]]; then
            continue
    fi

    #
    # Discard instances that are not either online or
    # transitioning to online.
    #
    if [[ "$sta" != 'ON' && "$nsta" != 'ON' ]]; then
            continue
    fi

    insts+=( "$fmri" )

done <<< "$all"

if (( ${#insts[@]} < 1 )); then
    printf 'no running binder instances found; exiting\n'
    exit 0
fi

#
# Each binder service instance is named "binder-$port", where $port is the port
# on which the instance is listening. Each instance chooses its metric port by
# adding 1000 to $port.
#
# We thus extract the port from each instance name, then add 1000 to get the
# metric port.
#
ports=()
for inst in "${insts[@]}"; do
    ports+=( $(( ${inst//$pattern/} + 1000 )) )
done

#
# We join the metric ports in a comma-separated list, then add this list as
# metricPorts mdata to allow scraping by cmon-agent.
#
mdata-put metricPorts "$(IFS=','; echo "${ports[*]}")"
