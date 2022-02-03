/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2022 Joyent, Inc.
 */

var vasync = require('vasync');
var core = require('../../lib');
var test = require('tap').test;
var helper = require('../helper.js');

///--- Globals

var dig = helper.dig;

var DOMAIN = 'db.foo.com';
var PATH = '/com/foo/db';
var RECORD = {
        type: 'database',
        database: {
                primary: 'tcp://user@192.168.0.1/postgres',
                standby: 'tcp://user@192.168.0.2/postgres',
                async: 'tcp://user@192.168.0.3/postgres'
        }
};

var server;
var zk;
var zkCache;

///--- Tests

test('setup', function (t) {
        var funcs = [
                function setup(_, cb) {
                        helper.createServer(function (err, res) {
                                if (err) {
                                        cb(err);
                                        t.error(err);
                                } else {
                                        server = res.server;
                                        zk = res.zk;
                                        zkCache = res.zkCache;
                                        cb();
                                }
                        });
                },

                function mkdir(_, cb) {
                        helper.zkMkdirP.call(zk, PATH, cb);
                },

                function setRecord(_, cb) {
                        var data = new Buffer(JSON.stringify(RECORD));
                        zk.create(PATH, data, {}, function (err) {
                                if (err && err.code === 'NODE_EXISTS') {
                                        zk.set(PATH, data, -1, cb);
                                } else {
                                        cb();
                                }
                        });
                }
        ];

        vasync.pipeline({funcs: funcs}, function (err) {
                if (err) {
                        console.error(err.stack);
                        t.error(err);
                        process.exit(1);
                }
                t.end();
        });
});


test('resolve record ok', function (t) {
        dig(DOMAIN, 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.ok(results.answers);
                t.equal(results.answers.length, 1);
                t.deepEqual(results.answers[0], {
                        name: DOMAIN,
                        ttl: 30,
                        type: 'A',
                        target: '192.168.0.1'
                });
                t.end();
        });
});

test('teardown', function (t) {
        helper.zkRmr.call(zk, '/com', function (err) {
                zk.on('close', function (cb) {
                        server.stop(cb);
                });
                zkCache.stop();
                zk.close();
                t.end();
        });
});
