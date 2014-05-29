// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var recursion = require('./recursion');
var server = require('./server');
var zk = require('./zk');



///--- Exports

module.exports = {
        bunyan: {
                querySerializer: function serialize(q) {
                        var out = {
                                domain: q.name(),
                                operation: q.operation(),
                                type: q.type()
                        };
                        return (out);
                }
        },
        Recursion: recursion
};

Object.keys(server).forEach(function (k) {
        module.exports[k] = server[k];
});

Object.keys(zk).forEach(function (k) {
        module.exports[k] = zk[k];
});
