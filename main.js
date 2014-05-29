// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');
var repl = require('repl');

var bunyan = require('bunyan');
var clone = require('clone');
var LRU = require('lru-cache');
var named = require('named');
var getopt = require('posix-getopt');
var vasync = require('vasync');
var xtend = require('xtend');
var zkplus = require('zkplus');

var core = require('./lib');



///--- Globals

var ARecord = named.ARecord;

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
        stream: process.stderr,
        serializers: {
                err: bunyan.stdSerializers.err,
                query: core.bunyan.querySerializer
        }
});
var ZK;



///--- Internal Functions

function createZkClient(cb) {

        //We want to continue on with init even if ZK isn't available, but we
        // still want to come up cleanly if we can.
        var calledback = false;
        function onFirst() {
                if (!calledback) {
                        return (cb());
                }
                calledback = true;
        }

        function onConnect() {
                zk.removeListener('error', onError);
                LOG.debug('ZK client ready');

                ZK = zk;
                zk.once('error', function (err) {
                        LOG.error(err, 'ZooKeeper client error');
                        zk.close();
                        ZK = null;
                });
                zk.once('close', createZkClient);
                onFirst();
        }

        function onError(err) {
                LOG.error(err, 'unable to connect to ZK');
                zk.removeListener('connect', onConnect);
                zk.close();
                setTimeout(createZkClient.bind(null), 2000);
                onFirst();
        }

        var zk = zkplus.createClient({
                connectTimeout: 1000,
                host: (process.env.ZK_HOST || '127.0.0.1'),
                log: LOG,
                timeout: 30000
        });
        zk.once('connect', onConnect);
        zk.once('error', onError);

        zk.connect();
}


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
                        function initCache(_, subcb) {
                                _.cache = new LRU({
                                        max: opts.size,
                                        maxAge: opts.expiry
                                });
                                subcb();
                        },
                        function initZk(_, subcb) {
                                _.zkClient = function () {
                                        return (ZK);
                                };
                                createZkClient(subcb);
                        },
                        function initRecursion(_, subcb) {
                                if (!opts.recursion) {
                                        return (subcb());
                                }
                                opts.recursion.log = LOG;
                                opts.recursion.zkClient = _.zkClient;
                                opts.recursion.cache = _.cache;
                                _.recursion = new core.Recursion(
                                        opts.recursion);
                                _.recursion.on('ready', subcb);
                        },
                        function initServer(_, subcb) {
                                _.server = core.createServer({
                                        cache: _.cache,
                                        name: NAME,
                                        log: LOG,
                                        port: opts.port,
                                        recursion: _.recursion,
                                        zkClient: _.zkClient
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

process.on('uncaughtException', function (err) {
        LOG.fatal({err: err}, 'uncaughtException (exiting error code 1)');
        process.exit(1);
});
