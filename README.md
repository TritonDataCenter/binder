<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# binder

Repository: <git@git.joyent.com:binder.git>
Browsing: <https://mo.joyent.com/binder>
Who: Mark Cavage
Docs: <https://mo.joyent.com/docs/binder>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/MANTA>

# Overview

This repo contains 'binder', which is a DNS server implemented on top of
ZooKeeper.  See docs/index.restdown for more information.

# Repository

    deps/           Git submodules (node et al).
    docs/           Project docs (restdown)
    lib/            Source files.
    node_modules/   Node.js deps, populated at build time.
    smf/manifests   SMF manifests
    test/           Test suite (using nodeunit)
    tools/          Miscellaneous dev/upgrade/deployment tools and data.
    Makefile
    package.json    npm module info (holds the project version)
    README.md

# Development

To run the binder server:

    git clone git@git.joyent.com:binder.git
    cd eng
    git submodule update --init
    make all
	. ./env.sh
    ZK_HOST=<ZK IP address> node main.js 2>&1 | bunyan

To update the docs, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.

# Testing

    ZK_HOST=<ZK IP address> make test

