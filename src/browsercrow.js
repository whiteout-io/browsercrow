(function(root, factory) {
    'use strict';

    if (typeof define === 'function' && define.amd) {
        define(['utf7', 'imap-handler', 'mimefuncs', './mimeparser', './bodystructure', './envelope'], function(ImapClient, utf7, imapHandler, mimefuncs, mimeParser, bodystructure, envelope) {
            return factory(utf7, imapHandler, mimefuncs, mimeParser, bodystructure, envelope);
        });
    } else if (typeof exports === 'object') {
        module.exports = factory(require('utf7'), require('imap-handler'), require('mimefuncs'), require('./mimeparser'), require('./bodystructure'), require('./envelope'));
    } else {
        root.BrowserCrow = factory(root.utf7, root.imapHandler, root.mimefuncs, root.mimeParser, root.bodystructure, root.envelope);
    }
}(this, function(utf7, imapHandler, mimefuncs, mimeParser, bodystructure, envelope) {
    'use strict';

    function BrowserCrow(options) {
        this.options = options || {};

        this.capabilities = [];
        this.outputHandlers = [];
        this.messageHandlers = [];
        this.fetchFilters = [];

        this.users = {
            testuser: {
                password: 'demo',
                xoauth2: {
                    accessToken: 'testtoken',
                    sessionTimeout: 3600 * 1000
                }
            }
        };

        this.allowedStatus = ['MESSAGES', 'RECENT', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN'];

        this.systemFlags = [].concat(this.options.systemFlags || ['\\Answered', '\\Flagged', '\\Draft', '\\Deleted', '\\Seen']);
        this.storage = this.options.storage || {
            'INBOX': {},
            '': {}
        };
        this.uidnextCache = {}; // keep nextuid values if mailbox gets deleted
        this.folderCache = {};
        this.indexFolders();
    }

    BrowserCrow.prototype.indexFolders = function() {
        var _self = this;
        var folders = {};

        var walkTree = function(path, separator, branch, namespace) {
            var keyObj = namespace === 'INBOX' ? {
                INBOX: true
            } : branch;

            Object.keys(keyObj).forEach(function(key) {

                var curBranch = branch[key],
                    curPath = (path ? path + (path.substr(-1) !== separator ? separator : '') : '') + key;

                folders[curPath] = curBranch;
                _self.processMailbox(curPath, curBranch, namespace);

                // ensure uid, flags and internaldate for every message
                curBranch.messages.forEach(function(message, i) {

                    // If the input was a raw message, convert it to an object
                    if (typeof message === 'string') {
                        curBranch.messages[i] = message = {
                            raw: message
                        };
                    }

                    _self.processMessage(message, curBranch);
                });

                if (namespace !== 'INBOX' && curBranch.folders && Object.keys(curBranch.folders).length) {
                    walkTree(curPath, separator, curBranch.folders, namespace);
                }

            });
        };

        // Ensure INBOX namespace always exists
        if (!this.storage.INBOX) {
            this.storage.INBOX = {};
        }

        Object.keys(this.storage).forEach(function(key) {
            if (key === 'INBOX') {
                walkTree('', '/', _self.storage, 'INBOX');
            } else {
                _self.storage[key].folders = _self.storage[key].folders || {};
                _self.storage[key].separator = _self.storage[key].separator || key.substr(-1) || '/';
                _self.storage[key].type = _self.storage[key].type || 'personal';

                if (_self.storage[key].type === 'personal' && _self.referenceNamespace === false) {
                    _self.referenceNamespace = key;
                }

                walkTree(key, _self.storage[key].separator, _self.storage[key].folders, key);
            }
        });

        if (!this.referenceNamespace) {
            this.storage[''] = this.storage[''] || {};
            this.storage[''].folders = this.storage[''].folders || {};
            this.storage[''].separator = this.storage[''].separator || '/';
            this.storage[''].type = 'personal';
            this.referenceNamespace = '';
        }

        if (!this.storage.INBOX.separator && this.referenceNamespace !== false) {
            this.storage.INBOX.separator = this.storage[this.referenceNamespace].separator;
        }

        if (this.referenceNamespace.substr(0, this.referenceNamespace.length - this.storage[this.referenceNamespace].separator.length).toUpperCase === 'INBOX') {
            this.toggleFlags(this.storage.INBOX.flags, ['\\HasChildren', '\\HasNoChildren'],
                this.storage[this.referenceNamespace].folders && Object.keys(this.storage[this.referenceNamespace].folders).length ? 0 : 1);
        }

        this.folderCache = folders;
    };

    BrowserCrow.prototype.getStatus = function(mailbox) {

        if (typeof mailbox === 'string') {
            mailbox = this.getMailbox(mailbox);
        }
        if (!mailbox) {
            return false;
        }

        var flags = {},
            seen = 0,
            unseen = 0,
            permanentFlags = [].concat(mailbox.permanentFlags || []);

        mailbox.messages.forEach(function(message) {
            if (message.flags.indexOf('\\Seen') < 0) {
                unseen++;
            } else {
                seen++;
            }

            message.flags.forEach(function(flag) {
                if (!flags[flag]) {
                    flags[flag] = 1;
                } else {
                    flags[flag]++;
                }

                if (permanentFlags.indexOf(flag) < 0) {
                    permanentFlags.push(flag);
                }
            });

        });

        return {
            flags: flags,
            seen: seen,
            unseen: unseen,
            permanentFlags: permanentFlags
        };
    };

    BrowserCrow.prototype.matchFolders = function(reference, match) {
        var _self = this;
        var includeINBOX = false;

        if (reference === '' && this.referenceNamespace !== false) {
            reference = this.referenceNamespace;
            includeINBOX = true;
        }

        if (!this.storage[reference]) {
            return [];
        }

        var namespace = this.storage[reference],
            lookup = (reference || '') + match,
            result = [];

        var query = new RegExp('^' + lookup.
            // escape regex symbols
            replace(/([\\^$+?!.():=\[\]|,\-])/g, '\\$1').replace(/[*]/g, '.*').replace(
                /[%]/g, '[^' + (namespace.separator.replace(/([\\^$+*?!.():=\[\]|,\-])/g, '\\$1')) + ']*') + '$', '');

        if (includeINBOX && ((reference ? reference + namespace.separator : '') + 'INBOX').match(query)) {
            result.push(this.folderCache.INBOX);
        }

        if (reference === '' && this.referenceNamespace !== false) {
            reference = this.referenceNamespace;
        }

        Object.keys(this.folderCache).forEach(function(path) {
            if (path.match(query) &&
                (_self.folderCache[path].flags.indexOf('\\NonExistent') < 0 || _self.folderCache[path].path === match) &&
                _self.folderCache[path].namespace === reference) {
                result.push(_self.folderCache[path]);
            }
        });

        return result;
    };

    BrowserCrow.prototype.processMailbox = function(path, mailbox, namespace) {
        mailbox.path = path;

        mailbox.namespace = namespace;
        mailbox.uid = mailbox.uid || 1;
        mailbox.uidvalidity = mailbox.uidvalidity || this.uidnextCache[path] || 1;
        mailbox.flags = [].concat(mailbox.flags || []);
        mailbox.allowPermanentFlags = 'allowPermanentFlags' in mailbox ? mailbox.allowPermanentFlags : true;
        mailbox.permanentFlags = [].concat(mailbox.permanentFlags || this.systemFlags);

        mailbox.subscribed = 'subscribed' in mailbox ? !!mailbox.subscribed : true;

        // ensure message array
        mailbox.messages = [].concat(mailbox.messages || []);

        // ensure highest uidnext
        mailbox.uidnext = Math.max.apply(Math, [mailbox.uidnext || 1].concat(mailbox.messages.map(function(message) {
            return (message.uid || 0) + 1;
        })));

        this.toggleFlags(mailbox.flags, ['\\HasChildren', '\\HasNoChildren'],
            mailbox.folders && Object.keys(mailbox.folders).length ? 0 : 1);
    };

    BrowserCrow.prototype.getMailbox = function(path) {
        if (path.toUpperCase() === 'INBOX') {
            return this.folderCache.INBOX;
        }
        return this.folderCache[path];
    };

    BrowserCrow.prototype.toggleFlags = function(flags, checkFlags, value) {
        var _self = this;

        [].concat(checkFlags || []).forEach(function(flag, i) {
            if (i === value) {
                _self.ensureFlag(flags, flag);
            } else {
                _self.removeFlag(flags, flag);
            }
        });
    };

    BrowserCrow.prototype.ensureFlag = function(flags, flag) {
        if (flags.indexOf(flag) < 0) {
            flags.push(flag);
        }
    };

    BrowserCrow.prototype.removeFlag = function(flags, flag) {
        var i;
        if (flags.indexOf(flag) >= 0) {
            for (i = flags.length - 1; i >= 0; i--) {
                if (flags[i] === flag) {
                    flags.splice(i, 1);
                }
            }
        }
    };

    BrowserCrow.prototype.processMessage = function(message, mailbox) {
        var _self = this;

        // internaldate should always be a Date object
        message.internaldate = message.internaldate || new Date();
        if (Object.prototype.toString.call(message.internaldate) === '[object Date]') {
            message.internaldate = this.formatInternalDate(message.internaldate);
        }
        message.flags = [].concat(message.flags || []);
        message.uid = message.uid || mailbox.uidnext++;

        // Allow plugins to process messages
        this.messageHandlers.forEach(function(handler) {
            handler(_self, message, mailbox);
        });
    };

    BrowserCrow.prototype.formatInternalDate = function(date) {
        var day = date.getDate(),
            month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
            ][date.getMonth()],
            year = date.getFullYear(),
            hour = date.getHours(),
            minute = date.getMinutes(),
            second = date.getSeconds(),
            tz = date.getTimezoneOffset(),
            tzHours = Math.abs(Math.floor(tz / 60)),
            tzMins = Math.abs(tz) - tzHours * 60;

        return (day < 10 ? '0' : '') + day + '-' + month + '-' + year + ' ' +
            (hour < 10 ? '0' : '') + hour + ':' + (minute < 10 ? '0' : '') +
            minute + ':' + (second < 10 ? '0' : '') + second + ' ' +
            (tz > 0 ? '-' : '+') + (tzHours < 10 ? '0' : '') + tzHours +
            (tzMins < 10 ? '0' : '') + tzMins;
    };

    BrowserCrow.prototype.connect = function(options) {
        options = options || {};
        if (!('debug' in options)) {
            options.debug = !!this.options.debug;
        }

        var connection = new CrowConnection(this, options);

        setTimeout(function() {
            connection._state = 'open';
            connection.onopen({
                target: connection,
                type: 'open',
                data: null
            });
            connection._ondata('* OK BrowserCrow ready for rumble\r\n');
        }, 15);

        return connection;
    };

    BrowserCrow.prototype.getMessageRange = function(mailbox, range, isUid) {
        range = (range || '').toString();
        if (typeof mailbox === 'string') {
            mailbox = this.getMailbox(mailbox);
        }

        var result = [],
            rangeParts = range.split(','),
            messages = Array.isArray(mailbox) ? mailbox : mailbox.messages,
            uid,
            totalMessages = messages.length,
            maxUid = 0,

            inRange = function(nr, ranges, total) {
                var range, from, to;
                for (var i = 0, len = ranges.length; i < len; i++) {
                    range = ranges[i];
                    to = range.split(':');
                    from = to.shift();
                    if (from === '*') {
                        from = total;
                    }
                    from = Number(from) || 1;
                    to = to.pop() || from;
                    to = Number(to === '*' && total || to) || from;

                    if (nr >= Math.min(from, to) && nr <= Math.max(from, to)) {
                        return true;
                    }
                }
                return false;
            };

        messages.forEach(function(message) {
            if (message.uid > maxUid) {
                maxUid = message.uid;
            }
        });

        for (var i = 0, len = messages.length; i < len; i++) {
            uid = messages[i].uid || 1;
            if (inRange(isUid ? uid : i + 1, rangeParts, isUid ? maxUid : totalMessages)) {
                result.push([i + 1, messages[i]]);
            }
        }

        return result;
    };

    BrowserCrow.prototype.getCommandHandler = function(command) {
        command = (command || '').toString().toUpperCase();
        return this.commandHandlers[command] || false;
    };

    function CrowConnection(server, options) {
        this.server = server;
        this.options = options || {};

        this.inputHandler = false;
        this._remainder = '';
        this._literalRemaining = '';
        this._command = '';
        this._commandQueue = [];
        this.notificationQueue = [];
        this._processing = false;

        this.state = 'Not Authenticated';

        this.options.binaryType = this.options.binaryType || 'string';
        this._state = 'init';
    }

    CrowConnection.prototype.onopen = function( /* evt */ ) {};
    CrowConnection.prototype.onerror = function( /* evt */ ) {
        throw new Error('Unhandled error event');
    };
    CrowConnection.prototype.ondata = function( /* evt */ ) {};
    CrowConnection.prototype.onclose = function( /* evt */ ) {};

    CrowConnection.prototype.send = function(data) {
        if (this._state !== 'open') {
            return this._onerror(new Error('Connection not open'));
        }

        if (this.options.binaryType === 'arraybuffer') {
            data = mimefuncs.fromTypedArray(data);
        }

        this._processInput(data);
    };

    CrowConnection.prototype.close = function() {
        var _self = this;

        if (this._state !== 'open') {
            return this._onerror(new Error('Connection not open'));
        }
        this._state = 'close';
        setTimeout(function() {
            _self.onclose({
                target: _self,
                type: 'close',
                data: null
            });
        }, 15);
    };

    CrowConnection.prototype._onerror = function(err, code) {
        if (code) {
            err.code = code;
        }
        this.onerror({
            target: this,
            type: 'error',
            data: err
        });
    };

    CrowConnection.prototype._ondata = function(data) {
        var _self = this;

        if (this._state !== 'open') {
            return;
        }

        if (this.options.binaryType === 'string' && typeof data === 'object') {
            data = mimefuncs.fromTypedArray(data);
        } else if (this.options.binaryType === 'arraybuffer' && typeof data === 'string') {
            data = mimefuncs.toTypedArray(data);
        }

        setTimeout(function() {
            _self.ondata({
                target: _self,
                type: 'data',
                data: data
            });
        }, 15);
    };

    CrowConnection.prototype.processNotifications = function(data) {
        var notification;
        for (var i = 0; i < this.notificationQueue.length; i++) {
            notification = this.notificationQueue[i];

            if (data && ['FETCH', 'STORE', 'SEARCH'].indexOf((data.command || '').toUpperCase()) >= 0) {
                continue;
            }

            this.sendResponse(notification);
            this.notificationQueue.splice(i, 1);
            i--;
            continue;
        }
    };

    CrowConnection.prototype.sendResponse = function(data) {
        var _self = this;

        if (!data.notification && data.tag !== '*') {
            // arguments[2] should be the original command
            this.processNotifications(arguments[2]);
        } else {
            // override values etc.
        }

        var args = Array.prototype.slice.call(arguments);
        [].concat(this.server.outputHandlers || []).forEach(function(handler) {
            handler.apply(null, [_self].concat(args));
        });

        // No need to display this response to user
        if (data.skipResponse) {
            return;
        }

        var compiled = imapHandler.compiler(data);

        if (this.options.debug) {
            console.log('SEND: %s', compiled);
        }

        this._ondata(compiled + '\r\n');
    };

    CrowConnection.prototype._processInput = function(str) {
        var match;

        if (this._literalRemaining) {
            if (this._literalRemaining > str.length) {
                this._literalRemaining -= str.length;
                this._command += str;
                return;
            }
            this._command += str.substr(0, this._literalRemaining);
            str = str.substr(this._literalRemaining);
            this._literalRemaining = 0;
        }

        this._remainder = str = this._remainder + str;
        while ((match = str.match(/(\{(\d+)(\+)?\})?\r?\n/))) {
            if (!match[2]) {
                if (this.inputHandler) {
                    this.inputHandler(this._command + str.substr(0, match.index));
                } else {
                    this.scheduleCommand(this._command + str.substr(0, match.index));
                }

                this._remainder = str = str.substr(match.index + match[0].length);
                this._command = '';
                continue;
            }

            if (match[3] !== '+') {
                this._ondata('+ Go ahead\r\n');
            }

            this._remainder = '';
            this._command += str.substr(0, match.index + match[0].length);
            this._literalRemaining = Number(match[2]);

            str = str.substr(match.index + match[0].length);

            if (this._literalRemaining > str.length) {
                this._command += str;
                this._literalRemaining -= str.length;
                return;
            } else {
                this._command += str.substr(0, this._literalRemaining);
                this._remainder = str = str.substr(this._literalRemaining);
                this._literalRemaining = 0;
            }
        }
    };

    CrowConnection.prototype.scheduleCommand = function(data) {
        var parsed;
        var tag = (data.match(/\s*([^\s]+)/) || [])[1] || '*';

        try {
            parsed = imapHandler.parser(data, {
                literalPlus: this.server.literalPlus
            });
        } catch (E) {
            this.sendResponse({
                tag: '*',
                command: 'BAD',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                        type: 'ATOM',
                        value: 'SYNTAX'
                    }]
                }, {
                    type: 'TEXT',
                    value: E.message
                }]
            }, 'ERROR MESSAGE', null, data, E);

            this.sendResponse({
                tag: tag,
                command: 'BAD',
                attributes: [{
                    type: 'TEXT',
                    value: 'Error parsing command'
                }]
            }, 'ERROR RESPONSE', null, data, E);

            return;
        }

        if (this.server.getCommandHandler(parsed.command)) {
            this._commandQueue.push({
                parsed: parsed,
                data: data
            });
            this.processQueue();
        } else {

            this.sendResponse({
                tag: parsed.tag,
                command: 'BAD',
                attributes: [{
                    type: 'TEXT',
                    value: 'Invalid command ' + parsed.command + ''
                }]
            }, 'UNKNOWN COMMAND', parsed, data);
        }
    };

    CrowConnection.prototype.processQueue = function(force) {
        var _self = this;
        var element;

        if (!force && this._processing) {
            return;
        }
        if (!this._commandQueue.length) {
            this._processing = false;
            return;
        }
        this._processing = true;

        element = this._commandQueue.shift();

        this.server.getCommandHandler(element.parsed.command)(this, element.parsed, element.data, function() {
            if (!_self._commandQueue.length) {
                _self._processing = false;
            } else {
                _self.processQueue(true);
            }
        });
    };

    BrowserCrow.prototype.fetchHandlers = {
        UID: function(connection, message) {
            return message.uid;
        },

        FLAGS: function(connection, message) {
            return message.flags.map(function(flag) {
                return {
                    type: 'ATOM',
                    value: flag
                };
            });
        },

        INTERNALDATE: function(connection, message) {
            return message.internaldate;
        },

        RFC822: function(connection, message) {
            return {
                type: 'LITERAL',
                value: message.raw
            };
        },

        'RFC822.SIZE': function(connection, message) {
            return message.raw.length;
        },

        'RFC822.HEADER': function(connection, message) {
            if (!message.parsed) {
                message.parsed = mimeParser(message.raw);
            }
            return {
                type: 'LITERAL',
                value: (message.parsed.header || []).join('\r\n') + '\r\n\r\n'
            };
        },

        BODYSTRUCTURE: function(connection, message) {
            if (!message.parsed) {
                message.parsed = mimeParser(message.raw);
            }
            return bodystructure(message.parsed, {
                upperCaseKeys: true,
                skipContentLocation: true
            });
        },

        ENVELOPE: function(connection, message) {
            if (!message.parsed) {
                message.parsed = mimeParser(message.raw);
            }
            return envelope(message.parsed.parsedHeader);
        },

        'BODY.PEEK': function(connection, message, query) {
            if (!query.section) {
                throw new Error('BODY.PEEK requires ans argument list');
            }
            return this.BODY(connection, message, query);
        },

        BODY: function(connection, message, query) {
            var partial, start, length, key, path, context;
            if (!message.parsed) {
                message.parsed = mimeParser(message.raw);
            }

            if (!query.section) {
                return bodystructure(message.parsed, {
                    body: true,
                    upperCaseKeys: true
                });
            }

            var value, keyList;
            if (!query.section.length) {
                value = message.raw;
            } else {
                if (query.section[0].type !== 'ATOM') {
                    throw new Error('Invalid BODY[<section>] identifier' + (query.section[0].value ? ' ' + query.section[0].type : ''));
                }

                key = (query.section[0].value || '').replace(/^(\d+\.)*(\d$)?/g, function(pathStr) {
                    path = pathStr.replace(/\.$/, '');
                    return '';
                }).toUpperCase();

                if (path) {
                    context = resolveContext(message.parsed, path);
                } else {
                    context = message.parsed;
                }

                switch (key) {

                    case 'HEADER':
                        if (query.section.length > 1) {
                            throw new Error('HEADER does not take any arguments');
                        }
                        value = (context.header || []).join('\r\n') + '\r\n\r\n';
                        break;

                    case 'MIME':
                        if (query.section.length > 1) {
                            throw new Error('MIME does not take any arguments');
                        }
                        value = (context.header || []).join('\r\n') + '\r\n\r\n';
                        break;

                    case 'TEXT':
                    case '':
                        if (query.section.length > 1) {
                            throw new Error('MIME does not take any arguments');
                        }
                        value = context.text || context.body || '';
                        break;

                    case 'HEADER.FIELDS':
                        if (query.section.length !== 2 && !Array.isArray(query.section[1])) {
                            throw new Error('HEADER.FIELDS expects a list of header fields');
                        }
                        value = '';
                        keyList = [];
                        query.section[1].forEach(function(queryKey) {
                            if (['ATOM', 'STRING', 'LITERAL'].indexOf(queryKey.type) < 0) {
                                throw new Error('Invalid header field name in list');
                            }
                            queryKey.type = 'ATOM'; // ensure that literals are not passed back in the response
                            keyList.push(queryKey.value.toUpperCase());
                        });

                        (context.header || []).forEach(function(line) {
                            var parts = line.split(':'),
                                key = (parts.shift() || '').toUpperCase().trim();
                            if (keyList.indexOf(key) >= 0) {
                                value += line + '\r\n';
                            }
                        });

                        value += '\r\n';
                        break;

                    case 'HEADER.FIELDS.NOT':
                        if (query.section.length !== 2 && !Array.isArray(query.section[1])) {
                            throw new Error('HEADER.FIELDS.NOT expects a list of header fields');
                        }
                        value = '';
                        keyList = [];
                        query.section[1].forEach(function(queryKey) {
                            if (['ATOM', 'STRING', 'LITERAL'].indexOf(queryKey.type) < 0) {
                                throw new Error('Invalid header field name in list');
                            }
                            queryKey.type = 'ATOM'; // ensure that literals are not passed back in the response
                            keyList.push(queryKey.value.toUpperCase());
                        });

                        (context.header || []).forEach(function(line) {
                            var parts = line.split(':'),
                                key = (parts.shift() || '').toUpperCase().trim();
                            if (keyList.indexOf(key) < 0) {
                                value += line + '\r\n';
                            }
                        });

                        value += '\r\n';
                        break;

                    default:
                        throw new Error('Not implemented: ' + query.section[0].value);
                }
            }

            if (query.partial) {
                partial = [].concat(query.partial || []);
                start = partial.shift() || 0;
                length = partial.pop();
                value = value.substr(start, length ? length : 0);
                if (query.partial.length === 2 && query.partial[1] > value.length) {
                    query.partial.pop();
                }
            }

            return {
                type: 'LITERAL',
                value: value
            };
        }
    };

    BrowserCrow.prototype.commandHandlers = {

        CAPABILITY: function(connection, parsed, data, callback) {
            if (parsed.attributes) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'CAPABILITY does not take any arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            var capabilities = ['IMAP4rev1'];

            Object.keys(connection.server.capabilities).forEach(function(key) {
                if (connection.server.capabilities[key](connection)) {
                    capabilities.push(key);
                }
            });

            connection.sendResponse({
                tag: '*',
                command: 'CAPABILITY',
                attributes: capabilities.map(function(capability) {
                    return {
                        type: 'TEXT',
                        value: capability
                    };
                })
            }, 'CAPABILITY LIST', parsed, data, capabilities);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'CAPABILITY COMPLETED', parsed, data, capabilities);

            callback();
        },

        LOGIN: function(connection, parsed, data, callback) {
            // LOGIN expects 2 string params - username and password
            if (!parsed.attributes ||
                parsed.attributes.length !== 2 ||
                !parsed.attributes[0] ||
                !parsed.attributes[1] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[1].type) < 0
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'LOGIN takes 2 string arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (connection.state !== 'Not Authenticated') {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Already authenticated, identity change not allowed'
                    }]
                }, 'LOGIN FAILED', parsed, data);
                return callback();
            }

            var users = connection.server.users,
                username = parsed.attributes[0].value,
                password = parsed.attributes[1].value;

            if (!users.hasOwnProperty(username) || users[username].password !== password) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Login failed: authentication failure'
                    }]
                }, 'LOGIN FAILED', parsed, data);
                return callback();
            }

            connection.state = 'Authenticated';

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'User logged in'
                }]
            }, 'LOGIN SUCCESS', parsed, data);

            callback();
        },

        LOGOUT: function(connection, parsed, data, callback) {
            if (parsed.attributes) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'LOGOUT does not take any arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            connection.state = 'Logout';

            connection.sendResponse({
                tag: '*',
                command: 'BYE',
                attributes: [{
                    type: 'TEXT',
                    value: 'LOGOUT received'
                }]
            }, 'LOGOUT UNTAGGED', parsed, data);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'LOGOUT COMPLETED', parsed, data);

            connection.close();

            callback();
        },

        LIST: function(connection, parsed, data, callback) {
            var folders;

            if (!parsed.attributes ||
                parsed.attributes.length !== 2 ||
                !parsed.attributes[0] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
                !parsed.attributes[1] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[1].type) < 0
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'LIST expects 2 string arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Log in first'
                    }]
                }, 'LIST FAILED', parsed, data);
                return callback();
            }

            if (!parsed.attributes[1].value) {
                // empty reference lists separator only
                var namespace = connection.server.storage[parsed.attributes[1].value || connection.server.referenceNamespace];
                if (namespace) {
                    connection.sendResponse({
                        tag: '*',
                        command: 'LIST',
                        attributes: [
                            [{
                                type: 'ATOM',
                                value: '\\Noselect'
                            }],
                            namespace.separator,
                            ''
                        ]
                    }, 'LIST ITEM', parsed, data);
                }
            } else {
                folders = connection.server.matchFolders(parsed.attributes[0].value, parsed.attributes[1].value);

                folders.forEach(function(folder) {
                    connection.sendResponse({
                        tag: '*',
                        command: 'LIST',
                        attributes: [
                            folder.flags.map(function(flag) {
                                return {
                                    type: 'ATOM',
                                    value: flag
                                };
                            }),
                            connection.server.storage[folder.namespace].separator,
                            folder.path
                        ]
                    }, 'LIST ITEM', parsed, data, folder);
                });
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'LIST', parsed, data);

            return callback();
        },

        LSUB: function(connection, parsed, data, callback) {
            if (!parsed.attributes ||
                parsed.attributes.length !== 2 ||
                !parsed.attributes[0] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
                !parsed.attributes[1] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[1].type) < 0
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'LSUB expects 2 string arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Log in first'
                    }]
                }, 'LSUB FAILED', parsed, data);
                return callback();
            }

            var folders = connection.server.matchFolders(parsed.attributes[0].value, parsed.attributes[1].value);

            folders.forEach(function(folder) {
                if (folder.subscribed) {
                    connection.sendResponse({
                        tag: '*',
                        command: 'LSUB',
                        attributes: [
                            folder.flags.map(function(flag) {
                                return {
                                    type: 'ATOM',
                                    value: flag
                                };
                            }),
                            connection.server.storage[folder.namespace].separator,
                            folder.path
                        ]
                    }, 'LSUB ITEM', parsed, data, folder);
                }
            });

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'LSUB', parsed, data);

            return callback();
        },

        STATUS: function(connection, parsed, data, callback) {
            if (!parsed.attributes ||
                parsed.attributes.length !== 2 ||
                !parsed.attributes[0] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
                !Array.isArray(parsed.attributes[1]) ||
                !parsed.attributes[1].length
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'STATUS expects mailbox argument and a list of status items'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Log in first'
                    }]
                }, 'STATUS FAILED', parsed, data);
                return callback();
            }

            var path = parsed.attributes[0].value,
                mailbox = connection.server.getMailbox(path),
                status, response = [],
                item;

            if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Invalid mailbox name'
                    }]
                }, 'STATUS FAILED', parsed, data);
                return callback();
            }

            status = connection.server.getStatus(mailbox);

            for (var i = 0, len = parsed.attributes[1].length; i < len; i++) {
                item = parsed.attributes[1][i];
                if (!item || item.type !== 'ATOM' || connection.server.allowedStatus.indexOf(item.value.toUpperCase()) < 0) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Invalid status element (' + (i + 1) + ')'
                        }]
                    }, 'STATUS FAILED', parsed, data);
                    return callback();
                }

                response.push({
                    type: 'ATOM',
                    value: item.value.toUpperCase()
                });

                switch (item.value.toUpperCase()) {
                    case 'MESSAGES':
                        response.push(mailbox.messages.length);
                        break;
                    case 'RECENT':
                        response.push(status.flags['\\Recent'] || 0);
                        break;
                    case 'UIDNEXT':
                        response.push(mailbox.uidnext);
                        break;
                    case 'UIDVALIDITY':
                        response.push(mailbox.uidvalidity);
                        break;
                    case 'UNSEEN':
                        response.push(status.unseen || 0);
                        break;
                    default:
                        response.push(mailbox[item.value.toUpperCase()]);
                        break;
                }
            }

            connection.sendResponse({
                tag: '*',
                command: 'STATUS',
                attributes: [{
                        type: 'ATOM',
                        value: path
                    },
                    response
                ]
            }, 'STATUS', parsed, data);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Status completed'
                }]
            }, 'STATUS', parsed, data);
            return callback();
        },

        SELECT: function(connection, parsed, data, callback) {
            if (!parsed.attributes ||
                parsed.attributes.length !== 1 ||
                !parsed.attributes[0] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'SELECT expects 1 mailbox argument'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Log in first'
                    }]
                }, 'SELECT FAILED', parsed, data);
                return callback();
            }

            var path = parsed.attributes[0].value,
                mailbox = connection.server.getMailbox(path);

            if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Invalid mailbox name'
                    }]
                }, 'SELECT FAILED', parsed, data);
                return callback();
            }

            connection.state = 'Selected';
            connection.selectedMailbox = mailbox;
            connection.readOnly = false;

            connection.notificationQueue = [];

            var status = connection.server.getStatus(mailbox),
                permanentFlags = status.permanentFlags.map(function(flag) {
                    return {
                        type: 'ATOM',
                        value: flag
                    };
                });

            connection.sendResponse({
                tag: '*',
                command: 'FLAGS',
                attributes: [permanentFlags]
            }, 'SELECT FLAGS', parsed, data);

            if (mailbox.allowPermanentFlags) {
                permanentFlags.push({
                    type: 'TEXT',
                    value: '\\*'
                });
            }

            connection.sendResponse({
                tag: '*',
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                            type: 'ATOM',
                            value: 'PERMANENTFLAGS'
                        },
                        permanentFlags
                    ]
                }]
            }, 'SELECT PERMANENTFLAGS', parsed, data);

            connection.sendResponse({
                tag: '*',
                attributes: [
                    mailbox.messages.length, {
                        type: 'ATOM',
                        value: 'EXISTS'
                    }
                ]
            }, 'SELECT EXISTS', parsed, data);

            connection.sendResponse({
                tag: '*',
                attributes: [
                    status.flags['\\Recent'] || 0, {
                        type: 'ATOM',
                        value: 'RECENT'
                    }
                ]
            }, 'SELECT RECENT', parsed, data);

            connection.sendResponse({
                tag: '*',
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                            type: 'ATOM',
                            value: 'UIDVALIDITY'
                        },
                        mailbox.uidvalidity
                    ]
                }]
            }, 'SELECT UIDVALIDITY', parsed, data);

            connection.sendResponse({
                tag: '*',
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                            type: 'ATOM',
                            value: 'UIDNEXT'
                        },
                        mailbox.uidnext
                    ]
                }]
            }, 'SELECT UIDNEXT', parsed, data);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                        type: 'ATOM',
                        value: 'READ-WRITE'
                    }]
                }, {
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'SELECT', parsed, data);
            return callback();
        },

        EXAMINE: function(connection, parsed, data, callback) {
            if (!parsed.attributes ||
                parsed.attributes.length !== 1 ||
                !parsed.attributes[0] ||
                ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'EXAMINE expects 1 mailbox argument'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Log in first'
                    }]
                }, 'EXAMINE FAILED', parsed, data);
                return callback();
            }

            var path = parsed.attributes[0].value,
                mailbox = connection.server.getMailbox(path);

            if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Invalid mailbox name'
                    }]
                }, 'EXAMINE FAILED', parsed, data);
                return callback();
            }

            connection.state = 'Selected';
            connection.selectedMailbox = mailbox;
            connection.readOnly = true;

            connection.notificationQueue = [];

            var status = connection.server.getStatus(mailbox),
                permanentFlags = status.permanentFlags.map(function(flag) {
                    return {
                        type: 'ATOM',
                        value: flag
                    };
                });

            connection.sendResponse({
                tag: '*',
                command: 'FLAGS',
                attributes: [permanentFlags]
            }, 'EXAMINE FLAGS', parsed, data);

            if (mailbox.allowPermanentFlags) {
                permanentFlags.push({
                    type: 'TEXT',
                    value: '\\*'
                });
            }

            connection.sendResponse({
                tag: '*',
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                            type: 'ATOM',
                            value: 'PERMANENTFLAGS'
                        },
                        permanentFlags
                    ]
                }]
            }, 'EXAMINE PERMANENTFLAGS', parsed, data);

            connection.sendResponse({
                tag: '*',
                attributes: [
                    mailbox.messages.length, {
                        type: 'ATOM',
                        value: 'EXISTS'
                    }
                ]
            }, 'EXAMINE EXISTS', parsed, data);

            connection.sendResponse({
                tag: '*',
                attributes: [
                    status.flags['\\Recent'] || 0, {
                        type: 'ATOM',
                        value: 'RECENT'
                    }
                ]
            }, 'EXAMINE RECENT', parsed, data);

            connection.sendResponse({
                tag: '*',
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                            type: 'ATOM',
                            value: 'UIDVALIDITY'
                        },
                        mailbox.uidvalidity
                    ]
                }]
            }, 'EXAMINE UIDVALIDITY', parsed, data);

            connection.sendResponse({
                tag: '*',
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                            type: 'ATOM',
                            value: 'UIDNEXT'
                        },
                        mailbox.uidnext
                    ]
                }]
            }, 'EXAMINE UIDNEXT', parsed, data);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'SECTION',
                    section: [{
                        type: 'ATOM',
                        value: 'READ-ONLY'
                    }]
                }, {
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'EXAMINE', parsed, data);
            return callback();
        },

        FETCH: function(connection, parsed, data, callback) {
            if (!parsed.attributes ||
                parsed.attributes.length !== 2 ||
                !parsed.attributes[0] ||
                ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
                !parsed.attributes[1] ||
                (['ATOM'].indexOf(parsed.attributes[1].type) < 0 && !Array.isArray(parsed.attributes[1]))
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'FETCH expects sequence set and message item names'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (connection.state !== 'Selected') {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Select mailbox first'
                    }]
                }, 'FETCH FAILED', parsed, data);
                return callback();
            }

            var messages = connection.selectedMailbox.messages;
            for (var i = 0, len = connection.notificationQueue.length; i < len; i++) {
                if (connection.notificationQueue[i].mailboxCopy) {
                    messages = connection.notificationQueue[i].mailboxCopy;
                    break;
                }
            }

            var range = connection.server.getMessageRange(messages, parsed.attributes[0].value, false),
                params = [].concat(parsed.attributes[1] || []),
                macros = {
                    'ALL': ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
                    'FAST': ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
                    'FULL': ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY']
                };

            if (parsed.attributes[1].type === 'ATOM' && macros.hasOwnProperty(parsed.attributes[1].value.toUpperCase())) {
                params = macros[parsed.attributes[1].value.toUpperCase()];
            }

            try {
                var flagsExist = false,
                    forceSeen = false;

                params.forEach(function(param, i) {
                    if (!param || (typeof param !== 'string' && param.type !== 'ATOM')) {
                        throw new Error('Invalid FETCH argument #' + (i + 1));
                    }

                    if (typeof param === 'string') {
                        param = params[i] = {
                            type: 'ATOM',
                            value: param
                        };
                    }

                    if (param.value.toUpperCase() === 'FLAGS') {
                        flagsExist = true;
                    }

                    if (!connection.readOnly) {
                        if (param.value.toUpperCase() === 'BODY' && param.section) {
                            forceSeen = true;
                        } else if (['RFC822', 'RFC822.HEADER'].indexOf(param.value.toUpperCase()) >= 0) {
                            forceSeen = true;
                        }
                    }
                });

                if (forceSeen && !flagsExist) {
                    params.push({
                        type: 'ATOM',
                        value: 'FLAGS'
                    });
                }

                range.forEach(function(rangeMessage) {
                    var name, key, handler, response = [],
                        value, i, len;
                    for (i = 0, len = connection.server.fetchFilters.length; i < len; i++) {
                        if (!connection.server.fetchFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                            return;
                        }
                    }

                    if (forceSeen && rangeMessage[1].flags.indexOf('\\Seen') < 0) {
                        rangeMessage[1].flags.push('\\Seen');
                    }

                    for (i = 0, len = params.length; i < len; i++) {
                        key = (params[i].value || '').toUpperCase();

                        handler = connection.server.fetchHandlers[key];
                        if (!handler) {
                            throw new Error('Invalid FETCH argument ' + (key ? ' ' + key : '#' + (i + 1)));
                        }

                        value = handler(connection, rangeMessage[1], params[i]);

                        name = typeof params[i] === 'string' ? {
                            type: 'ATOM',
                            value: key
                        } : params[i];
                        name.value = name.value.replace(/\.PEEK\b/i, '');
                        response.push(name);
                        response.push(value);
                    }

                    connection.sendResponse({
                        tag: '*',
                        attributes: [rangeMessage[0], {
                                type: 'ATOM',
                                value: 'FETCH'
                            },
                            response
                        ]
                    }, 'FETCH', parsed, data);
                });
            } catch (E) {
                console.log(E);
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'FETCH FAILED', parsed, data);
                return callback();
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'FETCH Completed'
                }]
            }, 'FETCH', parsed, data);
            return callback();
        }
    };

    function resolveContext(source, path) {
        var pathNumbers = path.split('.'),
            context = source,
            pathNumber,
            bodystruct = bodystructure(source, {
                upperCaseKeys: true
            });

        while ((pathNumber = pathNumbers.shift())) {
            pathNumber = Number(pathNumber);

            // If RFC bodystructure begins with 'MESSAGE' string, the bodystructure
            // for embedded message is in the element with index 8
            if ((bodystruct[0] || '').toString() === 'MESSAGE') {
                bodystruct = bodystruct[8];
            }

            // if this is a multipart list, use the selected one,
            // otherwise it is a single element, do not go any deeper
            if (bodystruct && Array.isArray(bodystruct[0])) {
                bodystruct = bodystruct[pathNumber - 1];
            }

            context = bodystruct.node;
        }

        return context;
    }

    return BrowserCrow;
}));