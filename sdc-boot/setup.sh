#!/usr/bin/bash
#
# Copyright (c) 2012 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/binder

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/sdc-boot/scripts/util.sh
sdc_common_setup

# Install zookeeper package, need to touch this file to disable the license prompt
touch /opt/local/.dli_license_accepted

app_name=${zone_role}

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/binder
mkdir -p /opt/smartdc/etc

echo "Importing zookeeper SMF manifest."
[[ -z $(/usr/bin/svcs -a | grep zookeeper) ]] && \
  /usr/sbin/svccfg import /opt/local/share/smf/zookeeper-server/manifest.xml

echo "Importing binder SMF manifest."
[[ -z $(/usr/bin/svcs -a | grep binder) ]] && \
  /usr/sbin/svccfg import /opt/smartdc/binder/smf/manifests/binder.xml

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
