/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var vasync = require('vasync');
var nzk = require('node-zookeeper-client');

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
                                        cb();
                                }
                        });
                },

                function mkdir(_, cb) {
                        self.zk.mkdirp(PATH, cb);
                },

                function setRecord(_, cb) {
                        var record = {
                                type: 'host',
                                host: {
                                        address: ADDR
                                }
                        };
                        var data = new Buffer(JSON.stringify(record));
                        self.zk.create(PATH, data, function (err) {
                                if (err && err.getCode() ===
                                        nzk.Exception.NODE_EXISTS) {

                                        self.zk.setData(PATH, data, cb);
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
                self.zk.on('disconnected', function () {
                        self.server.stop(callback);
                });
                self.zk.close();
        });
});


test('resolve record ok', function (t) {
        dig(RECORD, 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.ok(results.answers);
                t.equal(results.answers.length, 1);
                t.deepEqual(results.answers[0], {
                        name: RECORD,
                        ttl: 5,
                        type: 'A',
                        target: ADDR
                });
                t.end();
        });
});
