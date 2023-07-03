<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
    Copyright 2023 MNX Cloud, Inc.
-->

# Binder

This repository is part of the Triton DataCenter and Manta projects.
For contribution guidelines, issues, and general documentation, visit the main
[Triton](http://github.com/TritonDataCenter/triton) and
[Manta](http://github.com/TritonDataCenter/manta) project pages.

This repo contains Binder, which is a DNS server implemented on top of
ZooKeeper.  Hosts use [Registrar](http://github.com/TritonDataCenter/registrar)
to register themselves into DNS.  **Binder's behavior, use in service discovery,
and the ZooKeeper record format are described in the Registrar documentation.**

## Active Branches

There are currently two active branches of this repository, for the two
active major versions of Manta. See the [mantav2 overview
document](https://github.com/TritonDataCenter/manta/blob/master/docs/mantav2.md)
for details on major Manta versions.

- [`master`](../../tree/master/) - For development of mantav2, the latest
  version of Manta. This is the version used by Triton.
- [`mantav1`](../../tree/mantav1/) - For development of mantav1, the long
  term support maintenance version of Manta.

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

    git clone git@github.com:TritonDataCenter/binder.git
    cd binder
    git submodule update --init
    make all
    . ./env.sh
    ZK_HOST=<ZK IP address> node main.js 2>&1 | bunyan

# Testing

    ZK_HOST=<ZK IP address> make test
