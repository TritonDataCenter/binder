/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var vasync = require('vasync');

var core = require('../lib');

if (require.cache[__dirname + '/helper.js'])
        delete require.cache[__dirname + '/helper.js'];
var helper = require('./helper.js');



///--- Globals

var after = helper.after;
var before = helper.before;
var test = helper.test;
var dig = helper.dig;

var ADDR = '192.168.0.1';
var PATH = '/com/foo/hosta';
var RECORD = 'hosta.foo.com';



///--- Tests

before(function (callback) {
        var self = this;

        var funcs = [
                function setup(_, cb) {
                        helper.createServer(function (err, res) {
                                if (err) {
                                        cb(err);
                                } else {
                                        self.server = res.server;
                                        self.zk = res.zk;
                                        self.zkCache = res.zkCache;
                                        cb();
                                }
                        });
                },

                function mkdir(_, cb) {
                        helper.zkMkdirP.call(self.zk, PATH, cb);
                },

                function setRecord(_, cb) {
                        var record = {
                                type: 'host',
                                host: {
                                        address: ADDR
                                }
                        };
                        var data = new Buffer(JSON.stringify(record));
                        self.zk.create(PATH, data, {}, function (err) {
                                if (err && err.code === 'NODE_EXISTS') {
                                        self.zk.set(PATH, data, -1, cb);
                                } else {
                                        cb();
                                }
                        });
                }
        ];

        vasync.pipeline({funcs: funcs}, function (err) {
                if (err) {
                        console.error(err.stack);
                        process.exit(1);
                }

                callback();
        });
});


after(function (callback) {
        var self = this;
        helper.zkRmr.call(this.zk, '/com', function (err) {
                self.zk.on('close', function () {
                        self.server.stop(callback);
                });
                self.zkCache.stop();
                self.zk.close();
        });
});


test('resolve record ok', function (t) {
        dig(RECORD, 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'NOERROR');
                t.ok(results.answers);
                t.equal(results.answers.length, 1);
                t.deepEqual(results.answers[0], {
                        name: RECORD,
                        ttl: 30,
                        type: 'A',
                        target: ADDR
                });
                t.end();
        });
});

test('resolve reverse record ok', function (t) {
        var dom = ADDR.split('.').reverse().join('.') + '.in-addr.arpa';
        dig(dom, 'PTR', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'NOERROR');
                t.ok(results.answers);
                t.equal(results.answers.length, 1);
                t.deepEqual(results.answers[0], {
                        name: dom,
                        ttl: 30,
                        type: 'PTR',
                        target: RECORD + '.'
                });
                t.end();
        });
});

test('reverse record not found', function (t) {
        var dom = '1.2.3.4.in-addr.arpa';
        dig(dom, 'PTR', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'REFUSED');
                t.ok(results.answers);
                t.equal(results.answers.length, 0);
                t.end();
        });
});

test('reverse record invalid', function (t) {
        var dom = 'foobar.com';
        dig(dom, 'PTR', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'REFUSED');
                t.ok(results.answers);
                t.equal(results.answers.length, 0);
                t.end();
        });
});

test('reverse record invalid ip', function (t) {
        var dom = '1.2.in-addr.arpa';
        dig(dom, 'PTR', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'REFUSED');
                t.ok(results.answers);
                t.equal(results.answers.length, 0);
                t.end();
        });
});
