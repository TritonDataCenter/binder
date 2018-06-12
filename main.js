/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');
var repl = require('repl');

var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');
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
        stream: process.stdout,
        serializers: {
                err: bunyan.stdSerializers.err
        }
});

///--- Internal Functions

function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('hva:b:s:p:f:', process.argv);

        while ((option = parser.getopt()) !== undefined) {
                switch (option.option) {
                case 'a':
                        opts.expiry = parseInt(option.optarg, 10);
                        break;

                case 'b':
                        opts.balancerSocket = option.optarg;
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


function safeUnlink(socketPath) {
        try {
                fs.unlinkSync(socketPath);
        } catch (ex) {
                if (ex && ex.code && ex.code !== 'ENOENT') {
                        LOG.warn(ex, 'unlinking socket path "%s"', socketPath);
                }
        }
}


function run(opts) {
        var metricsManager = createMetricsManager({
                address: '0.0.0.0',
                log: LOG,
                staticLabels: {
                        datacenter: opts.datacenterName,
                        instance: opts.instance_uuid,
                        server: opts.server_uuid,
                        service: opts.service_name,
                        port: opts.port
                },
                /*
                 * A recommended convention for deriving the port number to be
                 * used by the corresponding metrics server is to add 1000 to
                 * the service port number.
                 */
                 port: opts.port + 1000,
                 restify: restify
        });
        metricsManager.listen(function () {});

        vasync.pipeline({
                'arg': {},
                'funcs': [
                        function initZk(_, subcb) {
                                _.zkCache = new core.ZKCache({
                                        log: LOG,
                                        domain: opts.dnsDomain,
                                        collector: metricsManager.collector
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
                        function initBalancer(_, subcb) {
                                if (!opts.balancerSocket) {
                                        setImmediate(subcb);
                                        return;
                                }

                                process.on('SIGTERM', function () {
                                        /*
                                         * When the SMF service is disabled, we
                                         * want to unlink our socket from the
                                         * socket directory so that the load
                                         * balancer knows we might not be
                                         * coming back.
                                         */
                                        LOG.info('caught SIGTERM; unlinking ' +
                                            'socket "%s"', opts.balancerSocket);
                                        safeUnlink(opts.balancerSocket);
                                        process.exit(0);
                                });

                                /*
                                 * Unlink our socket path now, in case a stale
                                 * socket remains in the file system.
                                 */
                                safeUnlink(opts.balancerSocket);

                                setImmediate(subcb);
                        },
                        function initServer(_, subcb) {
                                _.server = core.createServer({
                                        name: NAME,
                                        log: LOG,
                                        port: opts.port,
                                        balancerSocket: opts.balancerSocket,
                                        recursion: _.recursion,
                                        zkCache: _.zkCache,
                                        dnsDomain: opts.dnsDomain,
                                        datacenterName: opts.datacenterName,
                                        collector: metricsManager.collector
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
