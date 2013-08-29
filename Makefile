#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#

#
# Tools
#
BUNYAN		:= ./node_modules/.bin/bunyan
NODEUNIT	:= ./node_modules/.bin/nodeunit

#
# Files
#
DOC_FILES	 = index.restdown
JS_FILES	:= $(shell ls *.js) $(shell find lib test -name '*.js')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS    = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/binder.xml.in

#
# Variables
#

NODE_PREBUILT_TAG	= zone
NODE_PREBUILT_VERSION	:= v0.8.21

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_prebuilt.defs
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

#
# Env vars
#
PATH	:= $(NODE_INSTALL)/bin:${PATH}

#
# MG Variables
#

RELEASE_TARBALL         := binder-pkg-$(STAMP).tar.bz2
ROOT                    := $(shell pwd)
TMPDIR                  := /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NODEUNIT) $(REPO_DEPS) scripts sdc-scripts
	$(NPM) rebuild

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(NODEUNIT) ./node_modules/nodeunit npm-shrinkwrap.json

.PHONY: test
test: $(NODEUNIT)
	$(NODEUNIT) test/*.test.js 2>&1 | $(BUNYAN)

.PHONY: release
release: all docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(TMPDIR)/root/opt/smartdc/binder
	@mkdir -p $(TMPDIR)/root/opt/smartdc/boot
	@mkdir -p $(TMPDIR)/site
	@touch $(TMPDIR)/site/.do-not-delete-me
	@mkdir -p $(TMPDIR)/root
	@mkdir -p $(TMPDIR)/root/opt/smartdc/binder/etc
	cp -r   $(ROOT)/build \
		$(ROOT)/boot \
		$(ROOT)/lib \
		$(ROOT)/main.js \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/smf \
		$(TMPDIR)/root/opt/smartdc/binder
	mv $(TMPDIR)/root/opt/smartdc/binder/build/scripts \
	    $(TMPDIR)/root/opt/smartdc/binder/boot
	@mkdir -p $(TMPDIR)/root/opt/smartdc/sdc-boot
	cp $(ROOT)/sdc-boot/*.sh \
	    $(TMPDIR)/root/opt/smartdc/sdc-boot/
	mv $(TMPDIR)/root/opt/smartdc/binder/build/sdc-scripts \
	    $(TMPDIR)/root/opt/smartdc/sdc-boot/scripts
	ln -s /opt/smartdc/binder/boot/configure.sh \
	    $(TMPDIR)/root/opt/smartdc/boot/configure.sh
	chmod 755 $(TMPDIR)/root/opt/smartdc/binder/boot/configure.sh
	(cd $(TMPDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(TMPDIR)


.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/binder
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/binder/$(RELEASE_TARBALL)


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.node_prebuilt.targ
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
