// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var net = require('net');
var os = require('os');
var path = require('path');
var repl = require('repl');

var bunyan = require('bunyan');
var clone = require('clone');
var LRU = require('lru-cache');
var named = require('named');
var getopt = require('posix-getopt');
var uuid = require('node-uuid');
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

function createZkClient() {
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
        }

        function onError(err) {
                LOG.error(err, 'unable to connect to ZK');
                zk.removeListener('connect', onConnect);
                zk.close();
                setTimeout(createZkClient.bind(null), 2000);
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

        return (zk);
}


function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('hva:s:p:', process.argv);

        while ((option = parser.getopt()) !== undefined) {
                switch (option.option) {
                case 'a':
                        opts.expiry = parseInt(option.optarg, 10);
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

        return (xtend({}, clone(DEFAULTS), opts));
}


function usage(msg) {
        if (msg)
                console.error(msg);

        var str = 'usage: ' + NAME;
        str += '[-v] [-e cacheExpiry] [-s cacheSize] [-p port]';
        console.error(str);
        process.exit(msg ? 1 : 0);
}


function run(opts) {
        var cache = new LRU({
                max: opts.size,
                maxAge: opts.expiry
        });

        createZkClient();
        var server = core.createServer({
                cache: cache,
                name: NAME,
                log: LOG,
                port: opts.port,
                zkClient: function () {
                        return (ZK);
                }
        });

        server.start();
}



///--- Mainline

run(parseOptions());

process.on('uncaughtException', function (err) {
        LOG.fatal({err: err}, 'uncaughtException (exiting error code 1)');
        process.exit(1);
});
