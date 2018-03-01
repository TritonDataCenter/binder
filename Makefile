#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2017, Joyent, Inc.
#

#
# Files
#
JS_FILES :=		$(shell ls *.js) $(shell find lib test -name '*.js')
JSL_CONF_NODE =		tools/jsl.node.conf
JSL_FILES_NODE =	$(JS_FILES)
JSSTYLE_FILES =		$(JS_FILES)
JSSTYLE_FLAGS =		-f tools/jsstyle.conf
SMF_MANIFESTS_IN =	smf/manifests/single-binder.xml.in \
			smf/manifests/multi-binder.xml.in \
			smf/manifests/binder-balancer.xml.in \
			deps/zookeeper-common/smf/manifests/zookeeper.xml.in

#
# Variables
#

NODE_PREBUILT_TAG =		zone
NODE_PREBUILT_VERSION :=	v0.12.9
NODE_PREBUILT_IMAGE =		fd2cc906-8938-11e3-beab-4359c665ac99

include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
        include ./tools/mk/Makefile.node_prebuilt.defs
else
        include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

#
# Env vars
#
PATH :=			$(NODE_INSTALL)/bin:${PATH}

#
# MG Variables
#

RELEASE_TARBALL :=	binder-pkg-$(STAMP).tar.bz2
ROOT :=			$(shell pwd)
RELSTAGEDIR :=		/tmp/$(STAMP)

#
# Tools
#
BUNYAN :=		$(NODE) ./node_modules/.bin/bunyan
NODEUNIT :=		$(NODE) ./node_modules/.bin/nodeunit
CTFCONVERT :=		/bin/true

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS) scripts sdc-scripts
	$(NPM) install

# Needed for 'check-manifests' target.
check:: deps/zookeeper-common/.git

CLEAN_FILES += $(NODEUNIT) ./node_modules/nodeunit npm-shrinkwrap.json

#
# A load balancer sits in front of binder, built from the "mname-balancer.git"
# repository.
#
.PHONY: balancer
balancer: | deps/mname-balancer/.git
	@mkdir -p $(ROOT)/tmp/balancer.obj
	cd deps/mname-balancer && $(MAKE) PROG=$(ROOT)/balancer \
	    OBJ_DIR=$(ROOT)/tmp/balancer.obj \
	    CTFCONVERT=$(CTFCONVERT) \
	    $(ROOT)/balancer

CLEAN_FILES += tmp/balancer.obj balancer

#
# The "smf_adjust" tool is used to configure instances of the binder SMF
# service.
#
SMF_ADJUST_OBJS =	smf_adjust.o \
			nvlist_equal.o \
			utils.o \
			smfx.o

SMF_ADJUST_LIBS =	-lscf -lumem -lavl -lnvpair

SMF_ADJUST_CFLAGS =	-gdwarf-2 -m32 -std=c99 -D__EXTENSIONS__ \
			-Wall -Wextra -Werror \
			-pthread -Wno-unused-parameter \
			-Isrc/

SMF_ADJUST_OBJDIR =	tmp/smf_adjust.obj

CLEAN_FILES +=		tmp/smf_adjust.obj smf_adjust

smf_adjust: $(SMF_ADJUST_OBJS:%=$(SMF_ADJUST_OBJDIR)/%)
	gcc -o $@ $^ $(SMF_ADJUST_CFLAGS) $(SMF_ADJUST_LIBS)
	$(CTFCONVERT) -l $@ $@

$(SMF_ADJUST_OBJDIR)/%.o: src/%.c
	@mkdir -p $(@D)
	gcc -o $@ -c $(SMF_ADJUST_CFLAGS) $<

.PHONY: test
test: $(NODE_EXEC) all
	$(NODEUNIT) test/*.test.js 2>&1 | $(BUNYAN)

.PHONY: scripts
scripts: deps/manta-scripts/.git
	mkdir -p $(BUILD)/scripts
	cp deps/manta-scripts/*.sh $(BUILD)/scripts

.PHONY: release
release: all $(SMF_MANIFESTS) balancer smf_adjust
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/binder
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	@mkdir -p $(RELSTAGEDIR)/root
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/binder/etc
	cp -r $(ROOT)/lib \
	    $(ROOT)/main.js \
	    $(ROOT)/node_modules \
	    $(ROOT)/package.json \
	    $(ROOT)/sapi_manifests \
	    $(ROOT)/deps/zookeeper-common/sapi_manifests \
	    $(ROOT)/deps/zookeeper-common/smf \
	    $(ROOT)/smf \
	    $(RELSTAGEDIR)/root/opt/smartdc/binder
	cp \
	    $(ROOT)/balancer \
	    $(ROOT)/smf_adjust \
	    $(RELSTAGEDIR)/root/opt/smartdc/binder/lib/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/binder/build
	cp -r \
	    $(ROOT)/build/node \
	    $(ROOT)/build/scripts \
	    $(RELSTAGEDIR)/root/opt/smartdc/binder/build
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot/scripts
	cp -R $(RELSTAGEDIR)/root/opt/smartdc/binder/build/scripts/* \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/scripts/
	cp -R $(ROOT)/deps/sdc-scripts/* \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/deps/zookeeper-common/boot/* \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cd $(RELSTAGEDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site
	@rm -rf $(RELSTAGEDIR)


.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/binder
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/binder/$(RELEASE_TARBALL)


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
        include ./tools/mk/Makefile.node_prebuilt.targ
else
        include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
