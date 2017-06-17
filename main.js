/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');
var repl = require('repl');

var bunyan = require('bunyan');
var clone = require('clone');
var LRU = require('lru-cache');
var mname = require('mname');
var getopt = require('posix-getopt');
var vasync = require('vasync');
var xtend = require('xtend');

var core = require('./lib');

///--- Globals

var ARecord = mname.ARecord;

var CACHE;
var DEFAULTS = {
        expiry: 60000,
        size: 10000,
        port: 53
};
var NAME = 'binder';
var LOG = bunyan.createLogger({
        name: NAME,
        level: (process.env.LOG_LEVEL || 'info'),
        serializers: {
                err: bunyan.stdSerializers.err
        }
});

///--- Internal Functions

function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('hva:s:p:f:', process.argv);

        while ((option = parser.getopt()) !== undefined) {
                switch (option.option) {
                case 'a':
                        opts.expiry = parseInt(option.optarg, 10);
                        break;

                case 'f':
                        opts.configFile = option.optarg;
                        break;

                case 'h':
                        usage();
                        break;

                case 'p':
                        opts.port = parseInt(option.optarg, 10);
                        break;

                case 's':
                        opts.size = parseInt(option.optarg, 10);
                        break;

                case 'v':
                        // Allows us to set -vvv -> this little hackery
                        // just ensures that we're never < TRACE
                        LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
                        if (LOG.level() <= bunyan.DEBUG)
                                LOG = LOG.child({src: true});
                        break;

                default:
                        process.exit(1);
                        break;
                }
        }

        var fopts = {};
        opts.configFile = opts.configFile || './etc/config.json';
        try {
                var fcfg = fs.readFileSync(opts.configFile);
                fopts = JSON.parse(fcfg);
        } catch (e) {
                LOG.fatal(e);
                process.exit(1);
        }
        var options = xtend({}, clone(DEFAULTS), fopts, opts);
        LOG.info(options, 'starting with options');
        return (options);
}


function usage(msg) {
        if (msg)
                console.error(msg);

        var str = 'usage: ' + NAME;
        str += '[-v] [-e cacheExpiry] [-s cacheSize] [-p port] [-f file]';
        console.error(str);
        process.exit(msg ? 1 : 0);
}



function run(opts) {
        vasync.pipeline({
                'arg': {},
                'funcs': [
                        function initZk(_, subcb) {
                                _.zkCache = new core.ZKCache({
                                        log: LOG,
                                        domain: opts.dnsDomain
                                });
                                subcb();
                        },
                        function initRecursion(_, subcb) {
                                if (!opts.recursion) {
                                        return (subcb());
                                }
                                opts.recursion.log = LOG;
                                opts.recursion.zkCache = _.zkCache;
                                _.recursion = new core.Recursion(
                                        opts.recursion);
                                _.recursion.on('ready', subcb);
                        },
                        function initServer(_, subcb) {
                                _.server = core.createServer({
                                        name: NAME,
                                        log: LOG,
                                        port: opts.port,
                                        recursion: _.recursion,
                                        zkCache: _.zkCache,
                                        dnsDomain: opts.dnsDomain,
                                        datacenterName: opts.datacenterName
                                });
                                _.server.start(subcb);
                        }
                ]
        }, function (err) {
                if (err) {
                        LOG.error(err, 'error initing binder');
                        process.exit(1);
                }
                LOG.info('done with binder init');
        });
}



///--- Mainline

run(parseOptions());
