/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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
var dns = require('native-dns');
var named = require('named');
var events = require('events');
var sdc = require('sdc-clients');
var url = require('url');
var util = require('util');
var vasync = require('vasync');
var xtend = require('xtend');
var zk = require('./zk');



///--- Globals

var REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
var ARecord = named.ARecord;



///--- Functions

function Recursion(opts) {
        assert.object(opts, 'opts');
        assert.object(opts.log, 'opts.log');
        assert.string(opts.regionName, 'opts.regionName');
        assert.string(opts.datacenterName, 'opts.datacenterName');
        assert.string(opts.dnsDomain, 'opts.dnsDomain');
        assert.object(opts.ufds, 'opts.ufds');
        assert.func(opts.zkClient, 'opts.zkClient');
        assert.object(opts.cache, 'opts.cache');

        var self = this;
        self.log = opts.log;
        self.regionName = opts.regionName;
        self.datacenterName = opts.datacenterName;
        self.dnsDomain = opts.dnsDomain;
        self.ufdsConfig = opts.ufds;
        self.zkClient = opts.zkClient;
        self.cache = opts.cache;

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
                if (!self.zkClient()) {
                        return (subcb(new Error('Recursion: ZK is not yet ' +
                                                'available')));
                }
                var domain = self.ufdsConfig.url.replace('ldaps://', '');
                var query = new function () {
                        this.name = function () {
                                return (domain);
                        };
                };
                var req = {
                        cache: self.cache,
                        log: self.log,
                        query: query,
                        zkClient: self.zkClient()
                };
                zk.resolveName(req, function (err, record) {
                        if (err) {
                                return (subcb(err));
                        }
                        if (!record || !record.children ||
                            record.children.length < 1) {
                                return (subcb(new Error(
                                        'Recursion: not yet able to resolve ' +
                                                'ufds')));
                        }
                        var c = record.children[0];
                        var addr = c[c.type].address;
                        _.ufdsConfig = xtend({}, self.ufdsConfig);
                        _.ufdsConfig.url = 'ldaps://' + addr;
                        log.debug(_.ufdsConfig,
                                 'Recursion: resolved ufds config');
                        return (subcb());
                });
        }

        function initUfds(_, subcb) {
                var ufds = new sdc.UFDS(_.ufdsConfig);
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
                        if (r.datacenter === self.datacenterName) {
                                return;
                        }
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
        var self = this;
        var domainName = query.name();
        var question = dns.Question({
                name: domainName,
                type: 'A'
        });

        //Choose a host at random
        var host = hosts[Math.floor(Math.random() * hosts.length)];
        var port = 53;
        var req = dns.Request({
                question: question,
                server: { address: host, port: port, type: 'udp' },
                timeout: 3000,
                cache: self.cache
        });

        var error;
        var answers = [];
        req.on('timeout', function () {
                error = new Error('timed out');
        });

        req.on('message', function (err, answer) {
                if (err) {
                        error = err;
                        return;
                }
                answer.answer.forEach(function (a) {
                        answers.push({
                                addr: a.address,
                                ttl: a.ttl
                        });
                });
        });

        req.on('end', function () {
                if (error) {
                        return (cb(error));
                }
                self.log.debug({
                        'host': host,
                        'domainName': domainName,
                        'answers': answers
                }, 'Recursion: dns lookup complete');

                return (cb(null, answers));
        });

        req.send();
}



///--- API

Recursion.prototype.resolve = function (query) {
        var self = this;
        var domain = query.name();
        var answers = [];

        function respond() {
                if (answers.length === 0) {
                        //See comment in server.js
                        query.setError('eserver');
                } else {
                        answers.map(function (a) {
                                query.addAnswer(domain,
                                                new ARecord(a.addr),
                                                a.ttl);
                        });
                }
                self.log.debug({
                        query: query,
                        answers: query.answers()
                }, 'Recursion: sending query back to client');
                query.respond();
        }

        //Searching in the right dns domain
        if (domain.indexOf(self.dnsDomain,
                           domain.length - self.dnsDomain.length) === -1) {
                return (respond());
        }

        //Find the datacenter resolvers
        var p = domain.substring(0, domain.length - self.dnsDomain.length - 1);
        var dc = p.substring(p.lastIndexOf('.') + 1);
        if (self.dcs[dc] === undefined) {
                return (respond());
        }
        lookup.call(self, query, self.dcs[dc], function (err, ans) {
                if (!err) {
                        answers = ans;
                }
                return (respond());
        });
};



///--- Exports

module.exports = Recursion;
