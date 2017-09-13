/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var vasync = require('vasync');
var mod_zkstream = require('zkstream');

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
var PATH = '/com/foo/bar';
var SVC = 'bar.foo.com';
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
                self.zk.create(path, data, {}, function (err) {
                        if (err && err.code === 'NODE_EXISTS') {
                                self.zk.set(path, data, -1, cb);
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
                                        self.zkCache = res.zkCache;
                                        cb();
                                }
                        });
                },

                function mkdir(_, cb) {
                        helper.zkMkdirP.call(self.zk, PATH, cb);
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

                setTimeout(callback, 500);
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
        dig(SVC, 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'NOERROR');
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

test('resolve SRV records ok', function (t) {
        dig('_http._tcp.' + SVC, 'SRV', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'NOERROR');
                t.ok(results.answers);
                t.equal(results.answers.length, 2);
                results.answers.forEach(function (a) {
                        t.equal(a.ttl, 60);
                        t.equal(a.type, 'SRV');
                        t.equal(a.port, 80);
                        t.ok(/lb[AB]\.bar\.foo\.com\.?/.test(a.target));
                });
                t.end();
        });
});

test('SRV wrong service', function (t) {
        dig('_http._udp.' + SVC, 'SRV', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'NXDOMAIN');
                t.ok(results.answers);
                t.equal(results.answers.length, 0);
                t.end();
        });
});

test('SRV not exist', function (t) {
        dig('_http._tcp.foobar.foo.com', 'SRV', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'REFUSED');
                t.ok(results.answers);
                t.equal(results.answers.length, 0);
                t.end();
        });
});

test('resolve member record ok', function (t) {
        dig('lba.' + SVC, 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'NOERROR');
                t.ok(results.answers);
                t.equal(results.answers.length, 1);
                t.deepEqual(results.answers[0], {
                        name: 'lba.' + SVC,
                        ttl: 30,
                        type: 'A',
                        target: LBS['lbA']
                });
                t.end();
        });
});

test('resolve reverse record ok', function (t) {
        var dom = LBS['lbA'].split('.').reverse().join('.') + '.in-addr.arpa';
        dig(dom, 'PTR', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'NOERROR');
                t.ok(results.answers);
                t.equal(results.answers.length, 1);
                var a = results.answers[0];
                t.equal(a.name, dom);
                t.equal(a.type, 'PTR');
                t.equal(a.target, 'lba.bar.foo.com.');
                t.end();
        });
});


test('resolve record not found', function (t) {
        dig('blah.blah', 'A', function (err, results) {
                t.ifError(err);
                t.ok(results);
                t.equal(results.status, 'REFUSED');
                t.ok(results.answers);
                t.equal(results.answers.length, 0);
                t.end();
        });
});
