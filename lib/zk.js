// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');


///--- API

function domainToPath(domain) {
        assert.ok(domain);
        // Turns 1.moray.sds.joyent.com into
        // /com/joyent/sds/moray/1
        return ('/' + domain.split('.').reverse().join('/'));
}


function loadBalancerPath(path) {
        assert.ok(path);
        return (path + '/lbs');
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
        var path = domainToPath(opts.query.name());
        var res = { path: path };
        var zk = opts.zkClient;

        if ((res.record = cache.get(path))) {
                log.debug({
                        query: opts.query,
                        record: res.record
                }, 'getNameRecord: cache hit');
                return (callback(null, res));
        }

        log.debug({
                query: opts.query,
                path: path
        }, 'getNameRecord: entered (not cached)');
        zk.get(path, function (err, obj) {
                if (err) {
                        log.debug({
                                query: opts.query,
                                err: err
                        }, 'getNameRecord: Unable to resolve %s in ZK', path);
                        return (callback(err));
                }

                log.debug({
                        query: opts.query,
                        path: path,
                        record: obj
                }, 'getNameRecord: record found in ZK');
                cache.set(path, obj);
                res.record = obj;
                return (callback(null, res));
        });

        return (undefined);
}



///--- API

module.exports = {

        getNameRecord: getNameRecord

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
