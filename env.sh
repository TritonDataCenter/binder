#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

export PATH=$PWD/build/node/bin:$PWD/node_modules/.bin:$PATH

alias server='node main.js -p 1053 -v 2>&1 | bunyan'
alias npm='node `which npm`'
alias test='nodeunit test/*.test.js 2>&1 | bunyan'
