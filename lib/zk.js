/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert');
var path = require('path');

var vasync = require('vasync');
var nzk = require('node-zookeeper-client');


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
 * it's effectively a UNION depending on what type was.  For details, see the
 * "ZooKeeper data reference" in the Registrar README.
 */
function getNameRecord(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var cache = opts.cache;
        var log = opts.log;
        var p = opts.path;
        var record, res;
        var t;
        var zk = opts.zk;

        if ((res = cache.get(p))) {
                log.debug({
                        path: p,
                        record: res.value
                }, 'getNameRecord: cache hit');
                callback(res.err, res.value);
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
                        if (typeof (err.getCode) === 'function' &&
                            err.getCode() === nzk.Exception.NO_NODE)
                                cache.set(p, {err: err});
                        done(err);
                        return;
                }

                var obj = JSON.parse(data.toString('utf-8'));
                record = obj;
                log.debug({
                        path: p,
                        record: record
                }, 'getNameRecord: record found');
                cache.set(p, {err: null, value: record});
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
 * For details, see the Registrar README.
 */
function loadService(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var cache = opts.cache;
        var log = opts.log;
        var p = opts.path;
        var svc, res;
        var zk = opts.zk;

        if ((res = cache.get(p + '__service'))) {
                log.trace({
                        path: p,
                        service: res.value
                }, 'loadService: cache hit');
                return (callback(res.err, res.value));
        }

        zk.getChildren(p, function (err, children) {
                if (err) {
                        log.debug({
                                err: err,
                                path: p
                        }, 'loadService: zk.readdir failed');
                        if (typeof (err.getCode) === 'function' &&
                            err.getCode() === nzk.Exception.NO_NODE)
                                cache.set(p + '__service', {err: err});
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
                                        obj.name = c;
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
                                if (typeof (err2.getCode) === 'function' &&
                                    err2.getCode() === nzk.Exception.NO_NODE)
                                        cache.set(p + '__service', {err: err2});
                                return (callback(err2));
                        }

                        svc =  results.successes;
                        cache.set(p + '__service', {err: null, value: svc});
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
                path: domainToPath(options.domain || options.query.name()),
                zk: options.zkClient
        };

        getNameRecord(opts, function nrCallback(err, record) {
                if (options.stamp)
                        options.stamp('zk.getNameRecord');
                if (err) {
                        return (callback(err));
                }

                if (!record) {
                        var m = 'no error and no record returned from ' +
                                'getNameRecord';
                        log.error(err, m);
                        return (callback(new Error(m)));
                }

                switch (record.type) {
                case 'service':
                        loadService(opts, function svcCallback(err2, svc) {
                                if (options.stamp)
                                        options.stamp('zk.loadService');
                                if (err2)
                                        return (callback(err2));

                                record.children = svc;
                                log.trace({
                                        record: record
                                }, 'resolveName: svc record -- done');
                                return (callback(null, record));
                        });

                        break;


                default: // covers host/LB/DB/...
                        log.trace({
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
