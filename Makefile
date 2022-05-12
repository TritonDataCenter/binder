#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2022 Joyent, Inc.
#

NAME = binder

#
# Files
#
JS_FILES :=		$(shell ls *.js) $(shell find lib test -name '*.js')
ESLINT_FILES   = $(JS_FILES)
JSSTYLE_FILES =		$(JS_FILES)
JSSTYLE_FLAGS =		-f tools/jsstyle.conf
SMF_MANIFESTS_IN =	smf/manifests/single-binder.xml.in \
			smf/manifests/multi-binder.xml.in \
			smf/manifests/binder-balancer.xml.in \
			smf/manifests/metric-ports-updater.xml.in \
			smf/manifests/mksockdir.xml.in \
			deps/zookeeper-common/smf/manifests/zookeeper.xml.in

#
# Variables
#
ENGBLD_USE_BUILDIMAGE =		true
ENGBLD_REQUIRE := $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

BUILD_PLATFORM = 20210826T002459Z

ifeq ($(shell uname -s),SunOS)
        # minimal-64-lts@21.4.0
        NODE_PREBUILT_IMAGE=a7199134-7e94-11ec-be67-db6f482136c2
        NODE_PREBUILT_VERSION=v6.17.1
        NODE_PREBUILT_TAG=zone64
        include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
        include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
else
        NPM=npm
        NODE=node
        NPM_EXEC=$(shell which npm)
        NODE_EXEC=$(shell which node)
endif
include ./deps/eng/tools/mk/Makefile.node_modules.defs
include ./deps/eng/tools/mk/Makefile.smf.defs
include ./deps/eng/tools/mk/Makefile.ctf.defs

#
# Env vars
#
PATH :=			$(NODE_INSTALL)/bin:${PATH}

#
# MG Variables
#

RELEASE_TARBALL :=	$(NAME)-pkg-$(STAMP).tar.gz
ROOT :=			$(shell pwd)
RELSTAGEDIR :=		/tmp/$(NAME)-$(STAMP)
# used so that we can bypass the license-acceptance postinstall script
# that comes with sun-jre6-6.0.26 when installing it during buildimage
PKGSRC_PREFIX =		opt/local
JRE_LICENSE_COOKIE =	.dlj_license_accepted

# triton-origin-x86_64-21.4.0
BASE_IMAGE_UUID = 502eeef2-8267-489f-b19c-a206906f57ef
BUILDIMAGE_NAME =	mantav2-nameservice
BUILDIMAGE_DESC =	Manta nameservice
BUILDIMAGE_PKGSRC =	openjdk8-1.8.292nb3 \
			zookeeper-3.4.12 \
			gtar-base-1.34
AGENTS =		amon config registrar

#
# Tools
#
BUNYAN :=		$(NODE) ./node_modules/.bin/bunyan
NODEUNIT :=		$(NODE) ./node_modules/.bin/nodeunit

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) $(STAMP_NODE_MODULES) | $(NPM_EXEC) scripts sdc-scripts

# Needed for 'check-manifests' target.
check:: deps/zookeeper-common/.git

CLEAN_FILES += \
	$(NODEUNIT) \
	./node_modules/nodeunit \
	npm-shrinkwrap.json

$(SMF_MANIFESTS_IN): deps/zookeeper-common/.git


#
# A load balancer sits in front of binder, built from the "mname-balancer.git"
# repository.
#
.PHONY: balancer
balancer: | $(STAMP_CTF_TOOLS) deps/mname-balancer/.git
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

#
# Work around "file values.c is missing debug info" on older systems.
#
CTFFLAGS = -m

smf_adjust: $(SMF_ADJUST_OBJS:%=$(SMF_ADJUST_OBJDIR)/%) | $(STAMP_CTF_TOOLS)
	gcc -o $@ $^ $(SMF_ADJUST_CFLAGS) $(SMF_ADJUST_LIBS)
	$(CTFCONVERT) $(CTFFLAGS) $@

$(SMF_ADJUST_OBJDIR)/%.o: src/%.c
	@mkdir -p $(@D)
	gcc -o $@ -c $(SMF_ADJUST_CFLAGS) $<

ZKLOG_OBJS =		zklog.o
ZKLOG_LIBS =
ZKLOG_CFLAGS =		-gdwarf-2 -m64 \
			-Wall -Wextra -Werror -O2 \
			-std=c99 \
			-D__EXTENSIONS__ \
			-D_XOPEN_SOURCE=600 \
			-D_DEFAULT_SOURCE=1
ZKLOG_OBJDIR =		tmp/zklog.obj
CLEAN_FILES +=		tmp/zklog.obj zklog

zklog: $(ZKLOG_OBJS:%=$(ZKLOG_OBJDIR)/%) | $(STAMP_CTF_TOOLS)
	gcc -o $@ $^ $(ZKLOG_CFLAGS) $(ZKLOG_LIBS)
	$(CTFCONVERT) $(CTFFLAGS) $@

$(ZKLOG_OBJDIR)/%.o: src/%.c
	@mkdir -p $(@D)
	gcc -o $@ -c $(ZKLOG_CFLAGS) $<

.PHONY: test
test: $(NODE_EXEC) all
	$(NODEUNIT) test/*.test.js 2>&1 | $(BUNYAN)

.PHONY: scripts
scripts: deps/manta-scripts/.git
	mkdir -p $(BUILD)/scripts
	cp deps/manta-scripts/*.sh $(BUILD)/scripts

.PHONY: release
release: all $(SMF_MANIFESTS) balancer smf_adjust zklog
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
	    $(ROOT)/test \
	    $(ROOT)/bin \
	    $(RELSTAGEDIR)/root/opt/smartdc/binder
	cp \
	    $(ROOT)/zklog \
	    $(RELSTAGEDIR)/root/opt/smartdc/binder/bin/
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
	mkdir -p $(RELSTAGEDIR)/root/$(PKGSRC_PREFIX)
	touch $(RELSTAGEDIR)/root/$(PKGSRC_PREFIX)/$(JRE_LICENSE_COOKIE)
	cd $(RELSTAGEDIR) && \
	    $(TAR) -I pigz -cf $(ROOT)/$(RELEASE_TARBALL) root site
	@rm -rf $(RELSTAGEDIR)


.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) \
	    $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)


include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
        include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
        include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
else
        include ./deps/eng/tools/mk/Makefile.node.targ
endif
include ./deps/eng/tools/mk/Makefile.ctf.targ
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.node_modules.targ
include ./deps/eng/tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
