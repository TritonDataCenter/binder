/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

//
// ganked from: https://github.com/trevoro/node-named/blob/master/test/dig.js
//

var assert = require('assert');
var exec = require('child_process').exec;
var sprintf = require('util').format;



///--- Globals

var DIG = 'dig';



///--- Helpers

function parseAnswer(tokens) {
        var t = tokens.filter(function (v) {
                return (v !== '' ? v : undefined);
        });

        var r = {
                name:   t[0].replace(/\.$/, ''),
                ttl:    parseInt(t[1], 10),
                type:   t[3],
                target: t[4]
        };
        if (t[3] === 'SRV') {
                r.target = t[7];
                r.port = parseInt(t[6], 10);
                r.priority = parseInt(t[5], 10);
        }

        return (r);
}


function parseDig(output) {
        var lines = output.split(/\n/);
        var section = 'header';

        var results = {
                question: null,
                answers: [],
                additional: [],
                authority: []
        };

        /* BEGIN JSSTYLED */
        lines.forEach(function (l) {
                if (l === '') {
                        section = undefined;
                } else if (/^;; ->>HEADER<<-/.test(l)) {
                        section = 'header';
                } else if (/^;; QUESTION SECTION:/.test(l)) {
                        section = 'question';
                } else if (/^;; ANSWER SECTION:/.test(l)) {
                        section = 'answer';
                } else if (/^;; ADDITIONAL SECTION:/.test(l)) {
                        section = 'additional';
                } else if (/^;; AUTHORITY SECTION:/.test(l)) {
                        section = 'authority';
                }

                if (section === 'header') {
                        var m = l.match(/, status: ([A-Z]+), /);
                        if (m && m[1]) {
                                results.status = m[1];
                        }
                }

                if (section === 'question') {
                        if (/^;([A-Za-z0-9])*\./.test(l)) {
                                results.question =
                                        l.match(/([A-Za-z0-9_\-\.])+/)[0];
                        }
                }

                if (section === 'answer') {
                        if (/^([_A-Za-z0-9])+/.test(l)) {
                                var tokens = l.split(/[\t ]+/);
                                var answer = parseAnswer(tokens);
                                if (answer)
                                        results.answers.push(answer);
                        }
                }
        });
        /* END JSSTYLED */

        return (results);
}



///--- API

function dig(name, type, options, callback) {
        if (typeof (name) !== 'string')
                throw new TypeError('name (string) is required');
        if (typeof (type) !== 'string')
                throw new TypeError('type (string) is required');
        if (typeof (options) === 'function') {
                callback = options;
                options = {};
        }

        type = type.toUpperCase();

        var opts = '';
        if (options.server)
                opts += ' @' + options.server;
        if (options.port)
                opts += ' -p ' + options.port;

        var cmd = sprintf('dig %s -t %s %s +time=1 +retry=0', opts, type, name);
        exec(cmd, function (err, stdout, stderr) {
                if (err)
                        return (callback(err));

                return (callback(null, parseDig(stdout)));
        });
}



///--- Exports

module.exports = dig;
