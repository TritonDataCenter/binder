/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var dns = require('dns');
var url = require('url');

var named = require('named');
var nzk = require('node-zookeeper-client');

var zk = require('./zk');


///--- Globals

var ARecord = named.ARecord;



///--- Helpers

// Fisher-Yates shuffle
// http://sedition.com/perl/javascript-fy.html
function shuffle(arr) {
        if (arr.length === 0)
                return (arr);

        var i = arr.length;
        while (--i > 0) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = arr[i];
                arr[i] = arr[j];
                arr[j] = tmp;
        }

        return (arr);
}


function resolve(options, query) {
        query.response.header.ra = 0;
        if (!options.zkClient()) {
                options.log.error('no ZooKeeper client');
                query.setError('eserver');
                query.respond();
                return;
        }

        var domain = query.name();
        var req = {
                cache: options.cache,
                log: query._log,
                query: query,
                zkClient: options.zkClient()
        };

        req.log.debug({query: query}, 'resolve: new request');
        zk.resolveName(req, function (err, record) {
                if (err && (typeof (err.getCode) !== 'function' ||
                        err.getCode() !== nzk.Exception.NO_NODE)) {

                        req.log.debug({
                                err: err,
                                query: query
                        }, 'Error talking to ZK');
                        query.setError('eserver');
                } else if (err && err.getCode() === nzk.Exception.NO_NODE) {
                        req.log.debug({
                                query: query
                        }, 'Node not found in ZK');
                        //Recursion will take care of answering the query.
                        if (options.recursion) {
                                options.recursion.resolve(query);
                                return;
                        }
                        //The correct thing to do here would be to return a Name
                        // Error (code 3, see rfc1035, 4.1.1), but clients take
                        // that as an authoritative answer and don't try the
                        // next dns server in /etc/resolv.conf.  So, we lie and
                        // say Server error (code 2).
                        query.setError('eserver');
                } else {
                        var addr;
                        var ttl = record.ttl;
                        switch (record.type) {
                        case 'database':
                                var _u = url.parse(record.database.primary);
                                addr = _u.hostname;
                                query.addAnswer(domain, new ARecord(addr), ttl);
                                break;

                        case 'db_host':
                        case 'host':
                        case 'load_balancer':
                        case 'moray_host':
                        case 'redis_host':
                                addr = record[record.type].address;
                                query.addAnswer(domain, new ARecord(addr), ttl);
                                break;

                        case 'service':
                                // Inefficient, but easy to reason about.
                                shuffle(record.children.filter(function (sub) {
                                        return (sub.type === 'load_balancer' ||
                                                sub.type === 'moray_host' ||
                                                sub.type === 'ops_host' ||
                                                sub.type === 'rr_host' ||
                                                sub.type === 'redis_host');
                                }).map(function (host) {
                                        if (!host[host.type]) {
                                                //500 this request...
                                                query.setError('eserver');
                                                req.log.error({
                                                        query: query,
                                                        record: record
                                                }, 'bad zk info');
                                                return (null);
                                        }
                                        return (host[host.type].address);
                                })).forEach(function (a) {
                                        if (a === null) {
                                                return;
                                        }
                                        var ar = new ARecord(a);
                                        query.addAnswer(domain, ar, ttl);
                                });
                                break;

                        default:
                                req.log.debug({
                                        query: query,
                                        record: record
                                }, 'Not a known record type');
                                break;
                        }
                }

                req.log.debug({
                        query: query,
                        answers: query.answers()
                }, 'resolve: sending query back to client');
                query.respond();
        });
}



///--- API

function createServer(options) {
        assert.object(options, 'options');
        assert.object(options.log, 'options.log');
        assert.optionalObject(options.recursion, 'options.recursion');

        var server = named.createServer({
                name: options.name || 'binder',
                log: options.log
        });

        server.on('query', function onQuery(query) {
                query._start = Date.now();
                query._log = options.log.child({
                                req_id: query.id,
                                client: query._client
                        }, true);
                switch (query.type()) {
                case 'A':
                        resolve(options, query);
                        break;

                default:
                        // Anything unsupported we tell the client the truth
                        query.setError('enotimp');
                        query.respond();
                        break;
                }
        });

        server.on('after', function (query, bytes) {
                query._log.info({
                        query: query,
                        answers: query.answers(),
                        latency: Date.now() - query._start
                }, 'DNS query');
        });

        server.start = function start(callback) {
                server.on('listening', function () {
                        options.log.info({
                                host: options.host,
                                port: options.port
                        }, 'DNS service started');

                        if (typeof (callback) === 'function')
                                callback();
                });
                server.listen(options.port, options.host);
        };

        server.stop = function stop(callback) {
                server.close(callback);
        };

        return (server);
}



///--- Exports

module.exports = {

        createServer: createServer

};
