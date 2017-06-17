/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_path = require('path');

var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_zkstream = require('zkstream');
var mod_util = require('util');

function ZKCache(options) {
        mod_assert.object(options, 'options');
        mod_assert.object(options.log, 'options.log');
        mod_assert.string(options.domain, 'options.domain');

        this.ca_treeNodes = {};
        this.ca_zk = new mod_zkstream.Client({
                address: process.env.ZK_HOST || '127.0.0.1',
                port: 2181,
                log: options.log,
                timeout: 30000
        });
        this.ca_domain = options.domain;
        this.ca_log = options.log;

        var self = this;
        this.ca_zk.on('session', function () {
                self.rebuildCache();
        });
}
ZKCache.prototype.stop = function (cb) {
        if (cb) {
                this.ca_zk.on('close', cb);
        }
        this.ca_zk.close();
};
ZKCache.prototype.isReady = function () {
        var tn = this.ca_treeNodes[this.ca_domain];
        return (tn !== undefined);
};
ZKCache.prototype.getClient = function (cb) {
        this.ca_zk.get(cb);
};
ZKCache.prototype.lookup = function (domain) {
        return (this.ca_treeNodes[domain]);
};
ZKCache.prototype.rebuildCache = function () {
        var tn = this.ca_treeNodes[this.ca_domain];
        if (tn === undefined) {
                var parts = this.ca_domain.split('.');
                tn = new TreeNode(this,
                    parts.slice(1, parts.length).join('.'), parts[0]);
        }
        tn.rebind(this.ca_zk);
};

function TreeNode(cache, pDomain, name) {
        this.tn_name = name;
        this.tn_domain = name;
        if (pDomain.length > 0)
                this.tn_domain += '.' + pDomain;
        this.tn_path = domainToPath(this.tn_domain);
        this.tn_domain = this.tn_domain.toLowerCase();

        this.tn_cache = cache;
        this.tn_kids = {};
        this.tn_data = null;
        this.tn_log = cache.ca_log.child({
                component: 'ZKTreeNode',
                domain: this.tn_domain
        });
        this.tn_log.trace('adding node to cache at "%s"', this.tn_path);

        this.tn_cache.ca_treeNodes[this.tn_domain] = this;
}
Object.defineProperty(TreeNode.prototype, 'name', {
        get: function () {
                return (this.tn_name);
        }
});
Object.defineProperty(TreeNode.prototype, 'children', {
        get: function () {
                var self = this;
                return (Object.keys(this.tn_kids).
                    map(function (k) { return (self.tn_kids[k]); }));
        }
});
Object.defineProperty(TreeNode.prototype, 'data', {
        get: function () {
                return (this.tn_data);
        }
});
TreeNode.prototype.onChildrenChanged = function (zk, kids, stat) {
        var self = this;

        var newKids = {};
        kids.forEach(function (kid) {
                if (self.tn_kids[kid] !== undefined) {
                        newKids[kid] = self.tn_kids[kid];
                        delete (self.tn_kids[kid]);
                } else {
                        newKids[kid] = new TreeNode(self.tn_cache,
                            self.tn_domain, kid);
                        newKids[kid].rebind(zk);
                }
        });
        Object.keys(this.tn_kids).forEach(function (oldKid) {
                self.tn_kids[oldKid].unbind();
        });
        this.tn_kids = newKids;
};
TreeNode.prototype.onDataChanged = function (zk, data, stat) {
        var parsedData;
        try {
                var str = data.toString('utf-8');
                parsedData = JSON.parse(str);
        } catch (e) {
                /* Ignore data in a node that we can't parse */
                this.tn_log.warn(e, 'ignoring node %s: failed to parse data',
                    this.tn_path);
        }
        if (typeof (parsedData) !== 'object') {
                var er = new Error('Parsed JSON data is not an object');
                this.tn_log.warn(er, 'ignoring node %s: failed to parse data',
                    this.tn_path);
                return;
        }
        this.tn_data = parsedData;
};
TreeNode.prototype.unbind = function () {
        var self = this;
        if (this.tn_watcher) {
                this.tn_watcher.removeAllListeners('childrenChanged');
                this.tn_watcher.removeAllListeners('dataChanged');
        }
        Object.keys(this.tn_kids).forEach(function (k) {
                self.tn_kids[k].unbind();
        });
        if (this.tn_cache.ca_treeNodes[this.tn_domain] === this) {
                delete (this.tn_cache.ca_treeNodes[this.tn_domain]);
        }
};
TreeNode.prototype.rebind = function (zk) {
        var self = this;
        if (this.tn_watcher) {
                this.tn_watcher.removeAllListeners('childrenChanged');
                this.tn_watcher.removeAllListeners('dataChanged');
        }
        this.tn_watcher = zk.watcher(this.tn_path);
        this.tn_watcher.on('childrenChanged',
            this.onChildrenChanged.bind(this, zk));
        this.tn_watcher.on('dataChanged',
            this.onDataChanged.bind(this, zk));
        Object.keys(this.tn_kids).forEach(function (k) {
                self.tn_kids[k].rebind(zk);
        });
};

function domainToPath(domain) {
        mod_assert.ok(domain);
        return ('/' + domain.split('.').reverse().join('/'));
}

///--- API

module.exports = {
        ZKCache: ZKCache
};
