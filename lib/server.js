// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');
var dns = require('dns');
var url = require('url');

var named = require('named');
var uuid = require('node-uuid');
var zkplus = require('zkplus');

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
        var domain = query.name();
        var id = uuid.v1();
        var req = {
                cache: options.cache,
                id: id,
                log: options.log.child({id: id}, true),
                query: query,
                zkClient: options.zkClient
        };

        req.log.debug({query: query}, 'resolve: new request');
        zk.resolveName(req, function (err, record) {
                if (err && err.code !== zkplus.ZNONODE) {
                        req.log.debug({
                                err: err,
                                query: query
                        }, 'Error talking to ZK');

                } else if (err && err.code === zkplus.ZNONODE) {
                        req.log.debug({
                                query: query
                        }, 'Node not found in ZK; trying external DNS');
                        dns.resolve4(domain, function (err2, addresses) {
                                if (err2) {
                                        req.log.debug({
                                                query: query,
                                                err: err2
                                        }, 'domain not found externally');
                                } else {
                                        addresses.forEach(function (a) {
                                                var r = new ARecord(a);
                                                query.addAnswer(domain, r);
                                        });
                                }

                                req.log.debug({
                                        query: query,
                                        answers: query.answers()
                                }, 'resolve: sending query back to client');
                                return (query.respond());
                        });
                        return (undefined);

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
                        case 'redis_host':
                                addr = record[record.type].address;
                                query.addAnswer(domain, new ARecord(addr), ttl);
                                break;

                        case 'service':
                                // Inefficient, but easy to reason about.
                                shuffle(record.children.filter(function (sub) {
                                        return (sub.type === 'load_balancer');
                                }).map(function (lb) {
                                        return (lb.load_balancer.address);
                                })).forEach(function (a) {
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
                return (query.respond());
        });
}



///--- API

function createServer(options) {
        assert.ok(options);

        var server = named.createServer({
                name: options.name || 'binder',
                log: options.log
        });

        server.on('query', function onQuery(query) {
                switch (query.type()) {
                case 'A':
                        resolve(options, query);
                        break;

                default:
                        // Anything unsupported we just respond empty
                        query.respond();
                        break;
                }
        });

        server.on('after', function (query, bytes) {
                options.log.info({
                        query: query,
                        answers: query.answers()
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