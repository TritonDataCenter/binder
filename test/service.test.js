// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var uuid = require('node-uuid');
var vasync = require('vasync');
var zkplus = require('zkplus');

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
                        self.zk.update(PATH, SVC_VALUE, cb);
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
                                        self.zk.put(p, obj, _cb);
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
                                        self.zk.put(p, obj, _cb);
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
        this.zk.rmr('/com', function (err) {
                self.zk.on('close', function () {
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
