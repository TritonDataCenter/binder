<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

# Binder

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

This repo contains Binder, which is a DNS server implemented on top of
ZooKeeper.  Hosts use [Registrar](http://github.com/joyent/registrar) to
register themselves into DNS.  **Binder's behavior, use in service discovery,
and the ZooKeeper record format are described in the Registrar documentation.**

## Configuration

As binder is expected to run on the same host as a ZooKeeper server, it is
hard-coded to talk to `::1` to find ZK.  You can override this by setting the
environment variable `ZK_HOST` to some other IP address.  This is really only
for testing.  Also, it has a fixed in-memory cache of 1000 elements and 60s
expiration time over ZK.  These can be overriden with the command line flags of
`-s` and `-a`, respectively.  Although, again, it's defaulted, and hard-coded
in SMF that way.  There is no config file for binder.

## Troubleshooting

You can hack the SMF manifest in /opt/smartdc/binder/smf/manifests/binder.xml
and add `-d 2` to spew all nature of logs via SMF.

## Development

To run the binder server:

    git clone git@github.com:joyent/binder.git
    cd binder
    git submodule update --init
    make all
    . ./env.sh
    ZK_HOST=<ZK IP address> node main.js 2>&1 | bunyan

# Testing

    ZK_HOST=<ZK IP address> make test
