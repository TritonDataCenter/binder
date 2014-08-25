/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// Just a simple wrapper over nodeunit's exports syntax. Also exposes a common
// logger for all tests.

var bunyan = require('bunyan');
var Cache = require('expiring-lru-cache');
var named = require('named');
var vasync = require('vasync');
var zkplus = require('zkplus');

var core = require('../lib');
var dig = require('./dig');



///--- Helpers

function createCache(name) {
        var cache = new Cache({
                expiry: 10000,
                name: name || process.argv[1],
                size: 100
        });
        return (cache);
}

function createLogger(name, stream) {
        var log = bunyan.createLogger({
                level: (process.env.LOG_LEVEL || 'warn'),
                name: name || process.argv[1],
                stream: stream || process.stdout,
                src: true,
                serializers: named.bunyan.serializers
        });
        return (log);
}


function createServer(callback) {
        var log = createLogger();
        var zk;
        var server;

        var funcs = [
                function connectToZK(_, cb) {
                        var host = process.env.ZK_HOST || 'localhost';
                        var port = process.env.ZK_PORT || 2181;
                        zk = zkplus.createClient({
                                log: log,
                                servers: [ {
                                        host: host,
                                        port: port
                                } ],
                                timeout: 1000
                        });


                        zk.on('connect', cb);
                },

                function newServer(_, cb) {
                        server = core.createServer({
                                cache: createCache(),
                                host: '::1',
                                log: log,
                                name: process.argv[1],
                                port: 1053,
                                zkClient: zk
                        });
                        server.start(cb);
                }

        ];

        vasync.pipeline({funcs: funcs}, function (err) {
                if (err) {
                        callback(err);
                } else {
                        callback(null, {server: server, zk: zk});
                }
        });
}



///--- Exports

module.exports = {

        after: function after(teardown) {
                module.parent.exports.tearDown = function _teardown(callback) {
                        try {
                                teardown.call(this, callback);
                        } catch (e) {
                                console.error('after:\n' + e.stack);
                                process.exit(1);
                        }
                };
        },

        before: function before(setup) {
                module.parent.exports.setUp = function _setup(callback) {
                        try {
                                setup.call(this, callback);
                        } catch (e) {
                                console.error('before:\n' + e.stack);
                                process.exit(1);
                        }
                };
        },

        test: function test(name, tester) {
                module.parent.exports[name] = function _(t) {
                        var _done = false;
                        t.end = function end() {
                                if (!_done) {
                                        _done = true;
                                        t.done();
                                }
                        };
                        t.notOk = function notOk(ok, message) {
                                return (t.ok(!ok, message));
                        };

                        tester(t);
                };
        },

        dig: function _dig(name, type, callback) {
                dig(name, type, {server: '::1', port: 1053}, callback);
        },

        createCache: createCache,
        createLogger: createLogger,
        createServer: createServer

};
