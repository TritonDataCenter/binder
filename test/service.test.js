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

var HOSTS = {
        'hostA': '192.168.0.2',
        'hostB': '192.168.0.3',
        'hostC': '192.168.0.4'
};
var LBS = {
        'lbA': '10.0.1.2',
        'lbB': '10.0.1.3'
};
var PATH = '/com/joyent/foo';
var SVC = 'foo.joyent.com';
var SVC_VALUE = {
        type: 'service',
        service: {
                srvce: '_http',
                proto: '_tcp',
                port: 80
        },
        ttl: 60
};



///--- Tests

before(function (callback) {
        var self = this;

        function zkPut(path, obj, cb) {
                var data = new Buffer(JSON.stringify(obj));
                self.zk.create(path, data, function (err) {
                        if (err && err.getCode() ===
                                nzk.Exception.NODE_EXISTS) {

                                self.zk.setData(path, data, cb);
                        } else {
                                cb(err);
                        }
                });
        }

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

                function setServiceRecord(_, cb) {
                        zkPut(PATH, SVC_VALUE, cb);
                },

                function registerHosts(_, cb) {
                        vasync.forEachParallel({
                                func: function (k, _cb) {
                                        var obj = {
                                                type: 'host',
                                                host: {
                                                        address: HOSTS[k]
                                                }
                                        };
                                        var p = PATH + '/' + k;
                                        zkPut(p, obj, _cb);
                                },
                                inputs: Object.keys(HOSTS)
                        }, cb);
                },

                function registerLoadBalacners(_, cb) {
                        vasync.forEachParallel({
                                func: function (k, _cb) {
                                        var obj = {
                                                type: 'load_balancer',
                                                load_balancer: {
                                                        address: LBS[k]
                                                }
                                        };
                                        var p = PATH + '/' + k;
                                        zkPut(p, obj, _cb);
                                },
                                inputs: Object.keys(LBS)
                        }, cb);
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
        dig(SVC, 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.ok(results.answers);
                t.equal(results.answers.length, 2);
                results.answers.forEach(function (a) {
                        t.equal(a.name, SVC);
                        t.equal(a.ttl, 60);
                        t.equal(a.type, 'A');
                        t.ok(/10\.0\.1\.(2|3)/.test(a.target));
                });
                t.end();
        });
});


test('resolve record not found', function (t) {
        dig('blah.blah', 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.ok(results.answers);
                t.equal(results.answers.length, 0);
                t.end();
        });
});
