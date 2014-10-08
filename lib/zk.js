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
var zkplus = require('zkplus');


///--- Helpers

/**
 * Check and alert on error status in ZK client.
 */
function zkErrorCheck(zk) {
        // Since the zk client removes all error listeners on
        // close, we check our own zk.closeCalled
        if (zk.getState() !== 'connected' && !zk.closeCalled) {
                var e = new Error('ZooKeeper not connected');
                zk.emit('error', e);
        }
}


/**
 * Get all child nodes for a ZK entry while handling errors.
 */
function getDirChildren(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var p = opts.path;
        var zk = opts.zk;
        var log = opts.log;
        var t;

        var _done = false;
        function done(err, result) {
                clearTimeout(t);

                if (_done)
                        return;
                _done = true;

                log.debug({
                        path: p,
                        err: err,
                        result: result
                }, 'getDirChildren: %s', err ? 'failed' : 'done');
                callback(err, result);
        }

        log.debug({
                path: p
        }, 'getDirChildren: entered');

        t = setTimeout(function () {
                done(new Error('ZK timeout'));
                process.nextTick(zkErrorCheck.bind(null, zk));
        }, 1000);
        zk.readdir(p, done);
}


/**
 * Check ZK entry for matching srvce and proto fields
 */
function verifyServiceRecord(record, service, proto) {
        if (!record || record.type !== 'service')
                return (false);
        if (!record.service || !record.service.service)
                return (false);
        if (record.service.service.srvce !== service ||
            record.service.service.proto !== proto)
                return (false);
        return (true);
}


// pathToDomain(/com/joyent/sds/moray/1) => 1.moray.sds.joyent.com
function pathToDomain(p) {
        assert.ok(p);
        return (p.split('/').slice(1).reverse().join('.'));
}


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
                process.nextTick(zkErrorCheck.bind(null, zk));
        }, 1000);
        zk.get(p, function (err, obj) {
                if (err) {
                        log.debug({
                                path: p,
                                err: err
                        }, 'getNameRecord: zk.get failed');
                        done(err);
                        return;
                }

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
 *
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
 *   "type": "rr_host",
 *   "rr_host": {
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
        } else {
                svc  = {};
        }

        log.debug({ path: p }, 'loadService: entered (not cached)');

        vasync.pipeline({
                arg: svc,
                funcs: [
                        function listChildren(_, cb) {
                                getDirChildren({
                                        path: p,
                                        log: log,
                                        zk: zk
                                }, function (err, res) {
                                        if (!err) {
                                                svc = res;
                                        }
                                        cb(err);
                                });
                        },
                        function getChildren(_, cb) {
                                function getChild(c, callb) {
                                        var child = path.normalize(p + '/' + c);
                                        getNameRecord({
                                                path: child,
                                                log: log,
                                                zk: zk,
                                                cache: cache
                                        }, function (err, res) {
                                                if (err) {
                                                        return (callb(err));
                                                }
                                                // Store domain for SRV queries
                                                res._name = pathToDomain(child);
                                                return (callb(null, res));
                                        });
                                }
                                vasync.forEachParallel({
                                        inputs: svc,
                                        func: getChild
                                }, function (err, res) {
                                        if (!err) {
                                                svc = res.successes;
                                        }
                                        cb(err);
                                });
                        }
                ]
        }, function (err, res) {
                if (err) {
                        log.debug({
                                path: p,
                                err: err
                        }, 'loadService: failed');
                        return (callback(err));
                }
                log.debug({
                        path: p,
                        service: svc
                }, 'loadService: done');
                cache.set(p + '__service', svc);
                return (callback(null, svc));
        });

        return (undefined);
}


function resolveName(options, callback) {
        assert.ok(options);
        assert.ok(callback);

        var log = options.log;
        var qFields = {};
        if (options.query.type() === 'SRV') {
                // Extract service and proto from the front of the SRV request:
                // _moray._tcp.foobar.com -> foobar.com
                var fields = options.query.name().split('.');
                qFields.service = fields.shift();
                qFields.proto = fields.shift();
                qFields.path = domainToPath(fields.join('.'));
        } else {
                qFields.path = domainToPath(options.query.name());
        }
        var opts = {
                cache: options.cache,
                log: options.log,
                path: qFields.path,
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

                // Verify service/proto for SRV queries
                if (options.query.type() === 'SRV' &&
                    !verifyServiceRecord(record,
                                         qFields.service,
                                         qFields.proto)) {
                        // Simulate missing record if service/proto don't match
                        err = new Error('correct service entry not found');
                        err.code = zkplus.ZNONODE;
                        return (callback(err));
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
