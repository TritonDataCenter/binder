// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');
var path = require('path');

var vasync = require('vasync');



///--- API

// domainToPath(1.moray.sds.joyent.com) => /com/joyent/sds/moray/1
function domainToPath(domain) {
        assert.ok(domain);
        return ('/' + domain.split('.').reverse().join('/'));
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
        var zk = opts.zk;

        if ((record = cache.get(p))) {
                log.debug({
                        path: p,
                        record: record
                }, 'getNameRecord: cache hit');
                return (callback(null, record));
        }

        log.debug({
                path: p
        }, 'getNameRecord: entered (not cached)');
        zk.get(p, function (err, obj) {
                if (err) {
                        log.debug({
                                path: p,
                                err: err
                        }, 'getNameRecord: zk.get failed');
                        return (callback(err));
                }

                record = obj;
                log.debug({
                        path: p,
                        record: record
                }, 'getNameRecord: record found');
                cache.set(p, record);
                return (callback(null, record));
        });

        return (undefined);
}


/**
 * Returns all load-balancers and hosts associated with a "Service".  Note that
 * a service in our world is defined as an M LBs, advertised via DNS RR, fronting
 * N hosts.  The structure in ZK looks like:
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

        zk.readdir(p, function (err, children) {
                if (err) {
                        log.debug({
                                err: err,
                                path: p
                        }, 'loadService: zk.readdir failed');
                        return (callback(err));
                }

                var args = {
                        func: function getServiceSubEntry(c, cb) {
                                zk.get(path.normalize(p + '/' + c), cb);
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
                if (err)
                        return (callback(err));

                switch (record.type) {
                case 'host':
                        log.debug({
                                query: options.query,
                                record: record
                        }, 'resolveName: host record -- done');
                        return (callback(null, record));

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

                default:
                        return (callback(new Error('type not implemented: ' +
                                                   record.type)));
                }
        });

}


///--- API

module.exports = {

        getNameRecord: getNameRecord,
        loadService: loadService,
        resolveName: resolveName

};

// function listLoadBalancers(opts, callback) {
//         var p = zkLoadBalancerPath(opts.query.name());

//         LOG.debug({
//                 query: opts.query,
//                 path: p
//         }, 'Checking for load-balancers in ZK');

//         var result = CACHE.get(p);
//         if (result) {
//                 LOG.debug({
//                         query: opts.query,
//                         path: p,
//                         loadBalancers: result
//                 }, 'load-balancers found in cache');
//                 return (callback(null, result, p));
//         }

//         ZK.readdir(p, function (err, children) {
//                 if (err) {
//                         LOG.debug({
//                                 query: opts.query,
//                                 err: err,
//                                 path: p
//                         }, 'Unable to readdir %s in ZK', opts.query.name());
//                         callback(err);
//                 } else {
//                         CACHE.set(path, children);
//                         LOG.debug({
//                                 query: opts.query,
//                                 path: p,
//                                 loadBalancers: children
//                         }, 'load-balancers resolved');
//                         callback(null, children, p);
//                 }
//         });
//         return (undefined);
// }


// function getLoadBalancerData(opts, callback) {
//         var data = [];
//         var error;
//         var responses = 0;

//         function getData(p) {
//                 LOG.debug({
//                         query: opts.query,
//                         path: p
//                 }, 'Getting load balancer data from ZK');

//                 var result = CACHE.get(p);
//                 if (result) {
//                         LOG.debug({
//                                 query: opts.query,
//                                 path: p,
//                                 loadBalancer: result
//                         }, 'load balancer data found in cache');
//                         data.push(result);
//                 } else {
//                         ZK.get(p, function (err, obj) {
//                                 if (err) {
//                                         LOG.debug({
//                                                 err: err,
//                                                 path: p,
//                                                 query: opts.query
//                                         }, 'Unable to get %s in ZK');
//                                         error = error || err;
//                                 } else {
//                                         LOG.debug({
//                                                 query: opts.query,
//                                                 path: p,
//                                                 loadBalancer: obj
//                                         }, 'load balancer data found in ZK');
//                                         CACHE.set(p, obj);
//                                         data.push(obj);
//                                 }
//                         });
//                 }

//                 if (++responses == opts.loadBalancers.length) {
//                         if (error) {
//                                 callback(error);
//                         } else {
//                                 LOG.debug({
//                                         query: opts.query,
//                                         loadBalancers: opts.loadBalancers,
//                                         results: data
//                                 }, 'getLoadBalancerData: done');
//                                 callback(null, data);
//                         }
//                 }
//         }

//         opts.loadBalancers.forEach(function (lb) {
//                 getData(opts.path + '/' + lb);
//         });
// }
