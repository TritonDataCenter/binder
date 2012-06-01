// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');

var named = require('named');
var uuid = require('node-uuid');

var zk = require('./zk');


///--- Globals

var ARecord = named.ARecord;



///--- Helpers

function resolve(options, query) {
        var domain = query.name();
        var id = uuid.v1();
        var req = {
                cache: options.cache,
                id: id,
                log: options.log.child({id: id}, true),
                query: query,
                zkClient: options.zkClient
        };

        req.log.debug({query: query}, 'resolve: new request');
        zk.getNameRecord(req, function (err, res) {
                if (!err) {
                        switch (res.record.type) {
                        case 'host':
                                var addr = res.record.host.address;
                                query.addAnswer(domain, new ARecord(addr));
                                break;
                        default:
                                break;
                        }
                }

                req.log.debug({
                        query: query,
                        answers: query.answers()
                }, 'resolve: sending query back to client');
                return (query.respond());
        });
}



///--- API

function createServer(options) {
        assert.ok(options);

        var server = named.createServer({
                name: options.name || 'binder',
                log: options.log
        });

        server.on('query', function onQuery(query) {
                switch (query.type()) {
                case 'A':
                        resolve(options, query);
                        break;
                default:
                        // Anything unsupported we just respond empty
                        query.respond();
                        break;
                }
        });

        server.on('after', function (query, bytes) {
                options.log.info({
                        query: query,
                        answers: query.answers()
                }, 'DNS query');
        });

        server.start = function start(callback) {
                server.on('listening', function () {
                        options.log.info({
                                host: options.host,
                                port: options.port
                        }, 'DNS service started');

                        if (typeof (callback) === 'function')
                                callback();
                });
                server.listen(options.port, options.host);
        };

        server.stop = function stop(callback) {
                server.close(callback);
        };

        return (server);
}



///--- Exports

module.exports = {

        createServer: createServer

};