// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var cluster = require('cluster');
var net = require('net');
var os = require('os');
var path = require('path');
var repl = require('repl');

var bunyan = require('bunyan');
var Cache = require('expiring-lru-cache');
var named = require('named');
var nopt = require('nopt');
var uuid = require('node-uuid');
var zkplus = require('zkplus');

var core = require('./lib');



///--- Globals

var ARecord = named.ARecord;

var CACHE;
var NAME = 'binder';
var LOG;
var PARSED;
var SERVERS = [];
var ZK;

var OPTS = {
        'debug': Number,
        'cacheAge': Number,
        'cacheSize': Number,
        'port': Number,
        'help': Boolean
};

var SHORT_OPTS = {
        'a': ['--cacheAge'],
        'd': ['--debug'],
        'p': ['--port'],
        's': ['--cacheSize'],
        'h': ['--help']
};



///--- Internal Functions

function usage(code, message) {
        var _opts = '';
        Object.keys(SHORT_OPTS).forEach(function (k) {
                var longOpt = SHORT_OPTS[k][0].replace('--', '');
                var type = OPTS[longOpt].name || 'string';

                if (type && type === 'boolean')
                        type = '';
                type = type.toLowerCase();

                _opts += ' [--' + longOpt + ' ' + type + ']';
        });

        var msg = (message ? message + '\n' : '') +
                'usage: ' + path.basename(process.argv[1]) + _opts;

        console.error(msg);
        process.exit(code);
}


function run(callback) {
        ZK = zkplus.createClient({
                host: (process.env.ZK_HOST || 'localhost'),
                log: LOG
        });
        ZK.on('connect', function () {
                LOG.debug('ZK client created');

                var server = core.createServer({
                        cache: CACHE,
                        name: NAME,
                        log: LOG,
                        port: (PARSED.port || 53),
                        zkClient: ZK
                });


                server.start(function () {
                        SERVERS.push(server);
                        if (callback)
                                callback(null, server);
                });
        });
}


function startREPL() {
        net.createServer(function (socket) {
                var r = repl.start('bindjs> ', socket);
                r.context.SERVERS = SERVERS;
        }).listen(5002, 'localhost', function () {
                LOG.info('REPL started on 5002');
        });
}



///--- Mainline

PARSED = nopt(OPTS, SHORT_OPTS, process.argv, 2);
if (PARSED.help)
        usage(0);

LOG = bunyan.createLogger({
        level: PARSED.debug ? 'debug' : 'info',
        name: NAME,
        stream: process.stderr,
        serializers: {
                err: bunyan.stdSerializers.err,
                query: core.bunyan.querySerializer
        },
        src: PARSED.debug ? true : false
});

CACHE = new Cache({
        log: LOG,
        name: 'binder',
        size: (PARSED.cacheSize || 1000),
        expiry: (PARSED.cacheAge || 60000)
});

if (PARSED.debug) {
        if (PARSED.debug > 1)
                LOG.level('trace');

        run(startREPL());
} else if (cluster.isMaster) {
        for (var i = 0; i < os.cpus().length - 1; i++)
                cluster.fork();

        cluster.on('death', function (worker) {
                LOG.error({worker: worker}, 'worker %d exited');
                cluster.fork();
        });

        startREPL();
} else {
        run();
}

process.on('uncaughtException', function (err) {
        LOG.fatal({err: err}, 'uncaughtException (exiting error code 1)');
        process.exit(1);
});
