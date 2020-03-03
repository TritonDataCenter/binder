/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

// Just a simple wrapper over nodeunit's exports syntax. Also exposes a common
// logger for all tests.

var bunyan = require('bunyan');
var mname = require('mname');
var vasync = require('vasync');
var path = require('path');
var mod_zkstream = require('zkstream');

var core = require('../lib');
var dig = require('./dig');

///--- Helpers

function createLogger(name, stream) {
        var log = bunyan.createLogger({
                level: (process.env.LOG_LEVEL || 'info'),
                name: name || process.argv[1],
                stream: stream || process.stderr,
                src: true,
                serializers: mname.bunyan.serializers
        });
        return (log);
}


function createServer(callback) {
        var log = createLogger('bindertest');
        var arg = {};

        var funcs = [
                function connectToZK(_, cb) {
                        var host = process.env.ZK_HOST || '127.0.0.1';
                        var port = process.env.ZK_PORT || 2181;
                        _.zk = new mod_zkstream.Client({
                                address: host,
                                port: port,
                                timeout: 10000,
                                log: log
                        });
                        _.zk.once('connect', cb);
                },

                function makeZkCache(_, cb) {
                        _.zkCache = new core.ZKCache({
                                domain: 'foo.com',
                                log: log
                        });
                        cb();
                },

                function newServer(_, cb) {
                        _.server = core.createServer({
                                host: '::1',
                                log: log,
                                name: process.argv[1],
                                port: 1053,
                                dnsDomain: 'foo.com',
                                zkCache: _.zkCache
                        });
                        _.server.start(cb);
                }

        ];

        vasync.pipeline({
                funcs: funcs,
                arg: arg
        }, function (err) {
                if (err) {
                        callback(err);
                } else {
                        callback(null, arg);
                }
        });
}

function zkMkdirP(dpath, cb) {
        var zk = this;
        var sofar = '';
        var parts = [];
        dpath.split('/').forEach(function (part) {
                if (part !== '') {
                        sofar += '/' + part;
                        parts.push(sofar);
                }
        });
        var b = new Buffer('null', 'utf-8');
        vasync.forEachPipeline({
                func: function (dir, ccb) {
                        if (dir === '/') {
                                ccb();
                                return;
                        }
                        zk.create(dir, b, {}, function (err) {
                                if (err && err.code === 'NODE_EXISTS') {
                                        ccb();
                                        return;
                                }
                                if (err) {
                                        ccb(err);
                                        return;
                                }
                                ccb();
                        });
                },
                inputs: parts
        }, cb);
}

function zkRmr(ppath, cb) {
        var self = this;
        self.list(ppath, function (err, kids) {
                if (err) {
                        cb(err);
                        return;
                }
                kids = kids.map(function (k) {
                        return (path.join(ppath, k));
                });
                if (kids.length > 0) {
                        vasync.forEachParallel({
                                func: zkRmr.bind(self),
                                inputs: kids
                        }, function (err2, res) {
                                if (err2) {
                                        cb(err2);
                                        return;
                                }
                                done();
                        });
                } else {
                        done();
                }

                function done() {
                        self.delete(ppath, -1, function (err2) {
                                if (err2) {
                                        cb(err2);
                                        return;
                                }
                                cb(null);
                        });
                }
        });
}

///--- Exports

module.exports = {

        dig: function _dig(name, type, callback) {
                dig(name, type, {server: '::1', port: 1053}, callback);
        },

        createLogger: createLogger,
        createServer: createServer,
        zkRmr: zkRmr,
        zkMkdirP: zkMkdirP

};
