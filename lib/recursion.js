/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/**
 * Handles recursive dns calls for x-dc name resolutions.  All x-dc resolutions
 * are best effort, which means we take a very conservative approach in terms
 * of resource usage, timeout, etc.
 *
 * This object will periodically refresh the list of resolvers in other
 * datacenters from the following (logical) ufds search:
 *    sdc-ldap search -b 'region=[region_name], o=smartdc' objectclass=resolver
 *
 * Then will pass DNS queries to those resolvers if:
 *
 */

var assert = require('assert-plus');
var mname_client = require('mname-client');
var mname = require('mname');
var events = require('events');
var UFDS = require('ufds');
var url = require('url');
var util = require('util');
var vasync = require('vasync');
var xtend = require('xtend');
var zk = require('./zk');
var os = require('os');



///--- Globals

var REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
var ARecord = mname.ARecord;



///--- Functions

function Recursion(opts) {
        assert.object(opts, 'opts');
        assert.object(opts.log, 'opts.log');
        assert.string(opts.regionName, 'opts.regionName');
        assert.string(opts.datacenterName, 'opts.datacenterName');
        assert.string(opts.dnsDomain, 'opts.dnsDomain');
        assert.object(opts.ufds, 'opts.ufds');
        assert.object(opts.zkCache, 'opts.zkCache');

        var self = this;
        self.log = opts.log;
        self.regionName = opts.regionName;
        self.datacenterName = opts.datacenterName;
        self.dnsDomain = opts.dnsDomain;
        self.ufdsConfig = opts.ufds;
        self.zkCache = opts.zkCache;

        self.nsc = new mname_client.DnsClient({
                concurrency: 2
        });
        /*
         * This is for PTR lookups. Since we have no way to tell which DC a
         * particular IP belongs to at this level of the stack, we try all the
         * other binders we know about in parallel. This means we have to set
         * our concurrency limit to a very high value.
         *
         * mname_client doesn't let us set the concurrency limit per-query at
         * the moment, so we'll make a second client instance.
         */
        self.nscMax = new mname_client.DnsClient({
                concurrency: 100
        });

        //Init will set these up
        self.interval = null;
        self.ufds = null;
        self.dcs = {};

        process.nextTick(init.bind(self));
}
util.inherits(Recursion, events.EventEmitter);



///--- Helpers

function init() {
        var self = this;
        var log = self.log;
        var emittedReady = false;
        function emitReady() {
                if (!emittedReady) {
                        self.emit('ready');
                }
                emittedReady = true;
        }

        //Since we are dns, we need to resolve ufds "manually"
        function resolveUfds(_, subcb) {
                if (!self.zkCache.isReady()) {
                        return (subcb(new Error('Recursion: ZK is not yet ' +
                                                'available')));
                }
                var domain = self.ufdsConfig.url.replace('ldaps://', '');

                var node = self.zkCache.lookup(domain);

                if (!node || !node.data || node.data.type !== 'service' ||
                    !node.children[0]) {
                        return (subcb(new Error(
                            'Recursion: not yet able to resolve ufds')));
                }

                var kid = node.children[0];
                var addr = kid.data[kid.data.type].address;

                _.ufdsConfig = xtend({}, self.ufdsConfig);
                _.ufdsConfig.url = 'ldaps://' + addr;
                log.debug(_.ufdsConfig, 'Recursion: resolved ufds config');
                return (subcb());
        }

        function initUfds(_, subcb) {
                var ufds = new UFDS(_.ufdsConfig);
                ufds.once('connect', function () {
                        log.info('Recursion: UFDS connected');
                        ufds.removeAllListeners('error');
                        ufds.on('error', function (err) {
                                log.warn(err,
                                         'Recursion: UFDS: unexpected error');
                        });
                        self.ufds = ufds;
                        return (subcb());
                });
                ufds.once('error', function (err) {
                        if (!err) {
                                err = new Error(
                                        'Recursion: ufds init unknown error');
                        }
                        return (subcb(err));
                });
        }

        function setupRefresh(_, subcb) {
                refresh.call(self, function (err) {
                        var m;
                        if (err) {
                                m = 'Recursion: Error on first refresh';
                                log.error(err, m);
                                //We still continue since we're aiming
                                // for best effort.  We'll catch on the next
                                // refresh.
                        }
                        function onRefreshEnd(err2) {
                                if (err2) {
                                        m = 'Recursion: Error on refresh.';
                                        log.error(err2, m);
                               }
                        }
                        self.interval = setInterval(
                                refresh.bind(self, onRefreshEnd),
                                REFRESH_INTERVAL);
                        return (subcb());
                });
        }

        log.info('Recursion: Initing Clients...');
        function initClients() {
                vasync.pipeline({
                        'arg': {},
                        'funcs': [
                                resolveUfds,
                                initUfds,
                                setupRefresh
                        ]
                }, function (err) {
                        var m = 'Recursion: Binder is configured for ' +
                                'recursive dns but is unable to establish a ' +
                                'connection to UFDS.  Will try again in 15 ' +
                                'seconds, but will continue since recursive ' +
                                'resolves are best effort.';
                        if (err) {
                                log.warn(err, m);
                                setTimeout(initClients, 15000);
                        } else {
                                log.info('Recursion: Done initing clients.');
                        }
                        emitReady();
                });
        }
        initClients();
}



function refresh(cb) {
        var self = this;
        var log = self.log;
        function getResolvers(_, subcb) {
                if (!self.ufds) {
                        var m = 'Recursion: UFDS is not available yet.';
                        return (subcb(new Error(m)));
                }
                self.ufds.listResolvers(self.regionName, function (err, res) {
                        if (err) {
                                return (subcb(err));
                        }
                        log.debug({
                                resolvers: res
                        }, 'Recursion: found resolvers');
                        _.resolvers = res;
                        return (subcb());
                });
        }

        function filterResolvers(_, subcb) {
                var dcs = {};
                _.resolvers.forEach(function (r) {
                        if (dcs[r.datacenter] === undefined) {
                                dcs[r.datacenter] = [];
                        }
                        //Just in case...
                        if (dcs[r.datacenter].indexOf(r.ip) === -1) {
                                dcs[r.datacenter].push(r.ip);
                        }
                });
                log.debug({
                        dcs: dcs
                }, 'Recursion: setting recursion resolvers');
                self.dcs = dcs;
                return (subcb());
        }

        vasync.pipeline({
                'arg': {},
                'funcs': [
                        getResolvers,
                        filterResolvers
                ]
        }, function (err) {
                return (cb(err));
        });
}



function lookup(query, hosts, cb) {
        var opts = {
                domain: query.name(),
                type: query.type(),
                timeout: 3000,
                resolvers: hosts,
                filter: function (msg) {
                        msg.clearFlag('rd');
                }
        };

        var nsc = this.nsc;
        /* For PTR lookups, try all the resolvers. */
        if (query.type === 'PTR') {
                opts.errorThreshold = hosts.length;
                nsc = this.nscMax;
        }

        nsc.lookup(opts, function afterLookup(err, msg) {
                if (err) {
                        cb(err);
                        return;
                }

                cb(null, msg.getAnswers());
        });
}


var cachedNics;
var cachedNicsRefreshed;

///--- API

Recursion.prototype.resolve = function (query, cb) {
        var self = this;
        var domain = query.name();
        var answers = [];

        function respond() {
                if (answers.length === 0) {
                        //See comment in server.js
                        query.setError('refused');
                } else {
                        query._log.trace({answers: answers},
                            'recursion got answer from upstream');
                        answers.map(function (rec) {
                                var klass = mname[rec.type + 'Record'];
                                var inst;
                                assert.func(klass);
                                switch (rec.type) {
                                case 'A':
                                case 'AAAA':
                                case 'TXT':
                                case 'PTR':
                                case 'CNAME':
                                        inst = new klass(rec.target);
                                        break;
                                case 'SRV':
                                        inst = new klass(rec.target, rec.port,
                                            { priority: rec.priority,
                                            weight: rec.weight });
                                        break;
                                default:
                                        query._log.warn('recursion: upstream ' +
                                            'ns returned unsupported record ' +
                                            'type "%s", dropping', rec.type);
                                        return;
                                }
                                query.addAnswer(domain, inst, rec.ttl);
                        });
                }
                query.respond();
                cb();
        }

        //Searching in the right dns domain
        if (query.type() !== 'PTR' && domain.indexOf(self.dnsDomain,
            domain.length - self.dnsDomain.length) === -1) {
                return (respond());
        }

        /* For non-PTR lookups we can choose the exact datacenter */
        var upstreams;
        if (query.type() !== 'PTR') {
                var p = domain.substring(0, domain.length -
                    self.dnsDomain.length - 1);
                var dc = p.substring(p.lastIndexOf('.') + 1);
                if (self.dcs[dc] === undefined) {
                        return (respond());
                }
                upstreams = self.dcs[dc];

        } else {
                /* For PTR we have to ask everybody we know. */
                upstreams = [];
                Object.keys(self.dcs).forEach(function (tdc) {
                        self.dcs[tdc].forEach(function (r) {
                                upstreams.push(r);
                        });
                });
        }

        /*
         * Now filter out all upstream resolver addresses that match IP
         * addresses on our own NICs. This way we avoid recurring into
         * ourselves and wasting a bunch of effort.
         */
        var now = new Date();
        if (cachedNics == undefined ||
            now.getTime() - cachedNicsRefreshed.getTime() > 30000) {
                cachedNics = os.networkInterfaces();
                cachedNicsRefreshed = now;
        }

        var myAddrs = [];
        Object.keys(cachedNics).forEach(function (k) {
                cachedNics[k].forEach(function (nic) {
                        myAddrs.push(nic.address);
                });
        });
        upstreams = upstreams.filter(function (addr) {
                return (myAddrs.indexOf(addr) === -1);
        });

        if (upstreams.length < 1) {
                return (respond());
        }

        lookup.call(self, query, upstreams, function (err, ans) {
                if (!err) {
                        answers = ans;
                }
                respond();
        });
};



///--- Exports

module.exports = Recursion;
