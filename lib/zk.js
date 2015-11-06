/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert');
var path = require('path');

var vasync = require('vasync');



///--- API

// domainToPath(1.moray.sds.joyent.com) => /com/joyent/sds/moray/1
function domainToPath(domain) {
        assert.ok(domain);
        return ('/' + domain.toLowerCase().split('.').reverse().join('/'));
}


/**
 * Returns the 'typeof' record associated with this DNS name.
 *
 * The returned object is guaranteed to have a 'type' field, and after that
 * it's effectively a UNION depending on what type was. Examples below:
 *
 * {
 *   "type": "host",
 *   "host": {
 *     "address": "192.168.1.1"
 *   }
 * }
 *
 * {
 *   "type": "service",
 *   "service": {
 *      "srvce": "_http",
 *      "proto": "_tcp",
 *      "name": "example.com",
 *      "ttl": 60,
 *      "class": "IN",
 *      "pri": 0,
 *      "weight": 1,
 *      "port": 80,
 *      "target": "lb.1.moray.sds.us-east-1joyent.com"
 *    }
 * }
 *
 * {
 *   "type": "database",
 *   "database": {
 *     "primary": "tcp://foo@1.2.3.4/postgres",
 *     "standby": "tcp://foo@1.2.3.5/postgres",
 *     "async": "tcp://foo@1.2.3.6/postgres"
 *   }
 * }
 *
 * Note that in our world, "service" indicates that the name is load balanced,
 * and the caller is responsible for looking up the load balancer definitions.
 *
 */
function getNameRecord(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var cache = opts.cache;
        var log = opts.log;
        var p = opts.path;
        var record;
        var t;
        var zk = opts.zk;

        if ((record = cache.get(p))) {
                log.debug({
                        path: p,
                        record: record
                }, 'getNameRecord: cache hit');
                callback(null, record);
                return;
        }

        var _done = false;
        function done(err) {
                clearTimeout(t);
                if (_done)
                        return;

                _done = true;

                log.debug({
                        path: p,
                        err: err,
                        record: record
                }, 'getNameRecord: zk.get %s', err ? 'failed' : 'done');
                callback(err, record);
        }

        log.debug({
                path: p
        }, 'getNameRecord: entered (not cached)');

        t = setTimeout(function () {
                done(new Error('ZK timeout'));
                process.nextTick(function () {
                        // Since the zk client removes all error listeners on
                        // close, we check our own zk.closeCalled
                        if (zk.getState() !== 'connected' && !zk.closeCalled) {
                                var e = new Error('ZooKeeper not connected');
                                zk.emit('error', e);
                        }
                });
        }, 1000);
        zk.getData(p, function (err, data) {
                if (err) {
                        log.debug({
                                path: p,
                                err: err
                        }, 'getNameRecord: zk.get failed');
                        done(err);
                        return;
                }

                var obj = JSON.parse(data.toString('utf-8'));
                record = obj;
                log.debug({
                        path: p,
                        record: record
                }, 'getNameRecord: record found');
                cache.set(p, record);
                done(null);
        });
}


/**
 * Returns all load-balancers and hosts associated with a "Service".  Note that
 * a service in our world is defined as an M LBs, advertised via DNS RR,
 * fronting N hosts.  The structure in ZK looks like:
 *
 * /com/joyent/foo/<host|lb>
 *
 * Where foo is the 'service' record, as defined in getNameRecord, and there are
 * any number of ephemeral nodes underneath it, where their type is defined in
 * the node itself as a host or load_balancer.
 *
 * Each record, as in getNameRecord, is a JSON union:
 *
 * {
 *   "type": "host",
 *   "host": {
 *     "address": "192.168.1.1"
 *   }
 * }
 *
 * {
 *   "type": "load_balancer",
 *   "host": {
 *     "address": "192.168.1.1"
 *   }
 * }
 *
 */
function loadService(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var cache = opts.cache;
        var log = opts.log;
        var p = opts.path;
        var svc;
        var zk = opts.zk;

        if ((svc = cache.get(p + '__service'))) {
                log.debug({
                        path: p,
                        service: svc
                }, 'loadService: cache hit');
                return (callback(null, svc));
        }

        log.debug({ path: p }, 'loadService: entered (not cached)');

        zk.getChildren(p, function (err, children) {
                if (err) {
                        log.debug({
                                err: err,
                                path: p
                        }, 'loadService: zk.readdir failed');
                        return (callback(err));
                }

                var args = {
                        func: function getServiceSubEntry(c, cb) {
                                zk.getData(path.normalize(p + '/' + c),
                                        function (err2, data) {

                                        if (err2) {
                                                cb(err2);
                                                return;
                                        }
                                        var obj = JSON.parse(
                                                data.toString('utf-8'));
                                        cb(null, obj);
                                });
                        },
                        inputs: children
                };
                vasync.forEachParallel(args, function (err2, results) {
                        if (err2) {
                                log.debug({
                                        err: err2,
                                        children: children,
                                        path: p
                                }, 'loadService: zk.get failed');
                                return (callback(err2));
                        }

                        svc =  results.successes;
                        cache.set(p + '__service', svc);
                        log.debug({
                                path: p,
                                service: svc
                        }, 'loadService: done');
                        return (callback(null, svc));
                });

                return (undefined);
        });

        return (undefined);
}


function resolveName(options, callback) {
        assert.ok(options);
        assert.ok(callback);

        var log = options.log;
        var opts = {
                cache: options.cache,
                log: options.log,
                path: domainToPath(options.query.name()),
                zk: options.zkClient
        };

        log.debug({ query: options.query }, 'resolveName: entered');
        getNameRecord(opts, function nrCallback(err, record) {
                if (err) {
                        return (callback(err));
                }

                if (!record) {
                        var m = 'no error and no record returned from ' +
                                'getNameRecord';
                        log.error({
                                query: options.query,
                                err: err,
                                record: record
                        }, m);
                        return (callback(new Error(m)));
                }

                switch (record.type) {
                case 'service':
                        loadService(opts, function svcCallback(err2, svc) {
                                if (err2)
                                        return (callback(err2));

                                record.children = svc;
                                log.debug({
                                        query: options.query,
                                        record: record
                                }, 'resolveName: svc record -- done');
                                return (callback(null, record));
                        });

                        break;


                default: // covers host/LB/DB/...
                        log.debug({
                                query: options.query,
                                record: record
                        }, 'resolveName: host record -- done');
                        return (callback(null, record));
                }

                return (undefined);
        });
}


///--- API

module.exports = {

        getNameRecord: getNameRecord,
        loadService: loadService,
        resolveName: resolveName

};
