(function(root, factory) {
    'use strict';

    if (typeof define === 'function' && define.amd) {
        define(['utf7', 'imap-handler', 'mimefuncs', './browsercrow-mimeparser', './browsercrow-bodystructure', './browsercrow-envelope'], function(utf7, imapHandler, mimefuncs, mimeParser, bodystructure, envelope) {
            return factory(utf7, imapHandler, mimefuncs, mimeParser, bodystructure, envelope);
        });
    } else if (typeof exports === 'object') {
        module.exports = factory(require('utf7'), require('imap-handler'), require('mimefuncs'), require('./browsercrow-mimeparser'), require('./browsercrow-bodystructure'), require('./browsercrow-envelope'));
    } else {
        root.BrowserCrow = factory(root.utf7, root.imapHandler, root.mimefuncs, root.mimeParser, root.bodystructure, root.envelope);
    }
}(this, function(utf7, imapHandler, mimefuncs, mimeParser, bodystructure, envelope) {
    'use strict';

    /* jshint indent:false */

    function BrowserCrow(options) {
        var _self = this;

        this.options = options || {};

        this.connectionHandlers = [];
        this.capabilities = [];
        this.outputHandlers = [];
        this.messageHandlers = [];
        this.fetchFilters = [];
        this.pluginCommandHandlers = {};
        this.storeFilters = [];
        this.storeHandlers = {};
        this.searchHandlers = {};
        this.pluginFetchHandlers = {};

        this.connections = [];

        this.users = this.options.users || {
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

        [].concat(this.options.plugins || []).forEach(function(plugin) {
            switch (typeof plugin) {
                case 'string':
                    _self.pluginHandlers[plugin.toUpperCase()](_self);
                    break;
                case 'function':
                    plugin(_self);
                    break;
            }
        });
    }

    BrowserCrow.prototype.createTCPSocket = function() {
        var _self = this;
        return {
            open: function(host, port, options) {
                return _self.connect(options);
            }
        };
    };

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

    BrowserCrow.prototype.appendMessage = function(mailbox, flags, internaldate, raw, ignoreConnection) {
        if (typeof mailbox === 'string') {
            mailbox = this.getMailbox(mailbox);
        }

        var message = {
            flags: flags,
            internaldate: internaldate,
            raw: raw
        };

        mailbox.messages.push(message);
        this.processMessage(message, mailbox);

        this.notify({
            tag: '*',
            attributes: [
                mailbox.messages.length, {
                    type: 'ATOM',
                    value: 'EXISTS'
                }
            ]
        }, mailbox, ignoreConnection);
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

    BrowserCrow.prototype.validateInternalDate = function(date) {
        if (!date || typeof date !== 'string') {
            return false;
        }
        return !!date.match(/^([ \d]\d)\-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([\-+])(\d{2})(\d{2})$/);
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

        this.indexFolders();

        var connection = new CrowConnection(this, options);
        this.connections.push(connection);

        this.connectionHandlers.forEach(function(handler) {
            handler(connection);
        });

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

    BrowserCrow.prototype._removeConnection = function(connection) {
        for (var i = 0, len = this.connections.length; i < len; i++) {
            if (this.connections[i] === connection) {
                this.connections.splice(i, 1);
                break;
            }
        }
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

    BrowserCrow.prototype.registerCapability = function(keyword, handler) {
        this.capabilities[keyword] = handler || function() {
            return true;
        };
    };

    BrowserCrow.prototype.setCommandHandler = function(command, handler) {
        command = (command || '').toString().toUpperCase();
        this.pluginCommandHandlers[command] = handler;
    };


    BrowserCrow.prototype.getCommandHandler = function(command) {
        command = (command || '').toString().toUpperCase();
        return this.pluginCommandHandlers[command] || this.commandHandlers[command] || false;
    };

    BrowserCrow.prototype.notify = function(command, mailbox, ignoreConnection) {
        command.notification = true;
        this.connections.forEach(function(connection) {
            if (connection._state !== 'open') {
                return;
            }
            connection.onNotify({
                command: command,
                mailbox: mailbox,
                ignoreConnection: ignoreConnection
            });
        });
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
        this.directNotifications = false;

        this.state = 'Not Authenticated';

        this.options.binaryType = this.options.binaryType || 'string';
        this._state = 'init';
    }

    CrowConnection.prototype.onNotify = function(notification) {
        if (notification.ignoreConnection === this) {
            return;
        }
        if (!notification.mailbox ||
            (this.selectedMailbox &&
                this.selectedMailbox === (
                    typeof notification.mailbox === 'string' &&
                    this.getMailbox(notification.mailbox) || notification.mailbox))) {
            this.notificationQueue.push(notification.command);
            if (this.directNotifications) {
                this.processNotifications();
            }
        }
    };

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
            _self.server._removeConnection(_self);
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

    CrowConnection.prototype.expungeDeleted = function(mailbox, ignoreSelf, ignoreExists) {
        var deleted = 0,
            // old copy is required for those sessions that run FETCH before
            // displaying the EXPUNGE notice
            mailboxCopy = [].concat(mailbox.messages);

        for (var i = 0; i < mailbox.messages.length; i++) {
            if (mailbox.messages[i].flags.indexOf('\\Deleted') >= 0) {
                deleted++;
                mailbox.messages[i].ghost = true;
                mailbox.messages.splice(i, 1);
                this.server.notify({
                    tag: '*',
                    attributes: [
                        i + 1, {
                            type: 'ATOM',
                            value: 'EXPUNGE'
                        }
                    ]
                }, mailbox, ignoreSelf ? this : false);
                i--;
            }
        }

        if (deleted) {
            this.server.notify({
                tag: '*',
                attributes: [
                    mailbox.messages.length, {
                        type: 'ATOM',
                        value: 'EXISTS'
                    }
                ],
                // distribute the old mailbox data with the notification
                mailboxCopy: mailboxCopy,
            }, mailbox, ignoreSelf || ignoreExists ? this : false);
        }
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

        if (this.options.debug) {
            console.log('CLIENT: %s', (str || '').trim());
        }

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
            return connection.server.fetchHandlers.BODY(connection, message, query);
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

                        handler = connection.server.pluginFetchHandlers[key] || connection.server.fetchHandlers[key];
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
        },

        NOOP: function(connection, parsed, data, callback) {
            if (parsed.attributes) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'NOOP does not take any arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'NOOP completed', parsed, data);

            callback();
        },

        STORE: function(connection, parsed, data, callback) {
            var storeHandlers = getStoreHandlers();

            if (!parsed.attributes ||
                parsed.attributes.length !== 3 ||
                !parsed.attributes[0] ||
                ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
                !parsed.attributes[1] ||
                (['ATOM'].indexOf(parsed.attributes[1].type) < 0) ||
                !parsed.attributes[2] ||
                !(['ATOM', 'STRING'].indexOf(parsed.attributes[2].type) >= 0 || Array.isArray(parsed.attributes[2]))
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'STORE expects sequence set, item name and item value'
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
                }, 'STORE FAILED', parsed, data);
                return callback();
            }

            // Respond with NO if pending response messages exist
            try {
                connection.notificationQueue.forEach(function(notification) {
                    if (notification.attributes && (notification.attributes[1] || {}).value === 'EXPUNGE') {
                        throw new Error('Pending EXPUNGE messages, can not store');
                    }
                });
            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'STORE FAILED', parsed, data);
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
                itemName = (parsed.attributes[1].value || '').toUpperCase(),
                itemValue = [].concat(parsed.attributes[2] || []),
                affected = [];

            try {

                itemValue.forEach(function(item, i) {
                    if (!item || ['STRING', 'ATOM'].indexOf(item.type) < 0) {
                        throw new Error('Invalid item value #' + (i + 1));
                    }
                });

                range.forEach(function(rangeMessage) {

                    for (var i = 0, len = connection.server.storeFilters.length; i < len; i++) {
                        if (!connection.server.storeFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                            return;
                        }
                    }

                    var handler = connection.server.storeHandlers[itemName] || storeHandlers[itemName];
                    if (!handler) {
                        throw new Error('Invalid STORE argument ' + itemName);
                    }

                    handler(connection, rangeMessage[1], itemValue, rangeMessage[0], parsed, data);

                    affected.push(rangeMessage[1]);
                });

            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'STORE FAILED', parsed, data);
                return callback();
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'STORE completed'
                }]
            }, 'STORE COMPLETE', parsed, data, affected);

            callback();
        },

        EXPUNGE: function(connection, parsed, data, callback) {
            if (parsed.attributes) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'EXPUNGE does not take any arguments'
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

            connection.expungeDeleted(connection.selectedMailbox, false, true);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'EXPUNGE Completed'
                }]
            }, 'EXPUNGE completed', parsed, data);

            callback();
        },

        SEARCH: function(connection, parsed, data, callback) {

            if (connection.state !== 'Selected') {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Select mailbox first'
                    }]
                }, 'SEARCH FAILED', parsed, data);
                return callback();
            }

            if (!parsed.attributes || !parsed.attributes.length) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'SEARCH expects search criteria, empty query given'
                    }]
                }, 'SEARCH FAILED', parsed, data);
                return callback();
            }

            var params;

            try {
                params = parsed.attributes.map(function(argument, i) {
                    if (['STRING', 'ATOM', 'LITERAL', 'SEQUENCE'].indexOf(argument.type) < 0) {
                        throw new Error('Invalid search criteria argument #' + (i + 1));
                    }
                    return argument.value;
                });
            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'SEARCH FAILED', parsed, data);
                return callback();
            }

            var messages = connection.selectedMailbox.messages,
                searchResult;

            for (var i = 0, len = connection.notificationQueue.length; i < len; i++) {
                if (connection.notificationQueue[i].mailboxCopy) {
                    messages = connection.notificationQueue[i].mailboxCopy;
                    break;
                }
            }

            try {
                searchResult = makeSearch(connection, messages, params);
            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [{
                        type: 'TEXT',
                        value: E.stack
                    }]
                }, 'SEARCH FAILED', parsed, data);
                return callback();
            }

            if (searchResult && searchResult.list && searchResult.list.length) {
                connection.sendResponse({
                    tag: '*',
                    command: 'SEARCH',
                    attributes: searchResult.list.map(function(item) {
                        return searchResult.numbers[item.uid];
                    })
                }, 'SEARCH', parsed, data);
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'SEARCH completed'
                }]
            }, 'SEARCH', parsed, data);
            return callback();
        },

        'UID FETCH': function(connection, parsed, data, callback) {

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
                }, 'UID FETCH FAILED', parsed, data);
                return callback();
            }

            var range = connection.server.getMessageRange(connection.selectedMailbox, parsed.attributes[0].value, true),
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
                var uidExist = false,
                    flagsExist = false,
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

                    if (param.value.toUpperCase() === 'UID') {
                        uidExist = true;
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

                if (!uidExist) {
                    params.push({
                        type: 'ATOM',
                        value: 'UID'
                    });
                }

                range.forEach(function(rangeMessage) {
                    var name, key, handler, response = [],
                        value;

                    if (forceSeen && rangeMessage[1].flags.indexOf('\\Seen') < 0) {
                        rangeMessage[1].flags.push('\\Seen');
                    }

                    for (var i = 0, len = params.length; i < len; i++) {
                        key = (params[i].value || '').toUpperCase();

                        handler = connection.server.pluginFetchHandlers[key] || connection.server.fetchHandlers[key];
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
                    }, 'UID FETCH', parsed, data);
                });
            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'UID FETCH FAILED', parsed, data);
                return callback();
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'UID FETCH Completed'
                }]
            }, 'UID FETCH', parsed, data);
            return callback();
        },

        'UID SEARCH': function(connection, parsed, data, callback) {
            if (connection.state !== 'Selected') {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Select mailbox first'
                    }]
                }, 'UID SEARCH FAILED', parsed, data);
                return callback();
            }

            if (!parsed.attributes || !parsed.attributes.length) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'UID SEARCH expects search criteria, empty query given'
                    }]
                }, 'UID SEARCH FAILED', parsed, data);
                return callback();
            }

            var params;

            try {
                params = parsed.attributes.map(function(argument, i) {
                    if (['STRING', 'ATOM', 'LITERAL', 'SEQUENCE'].indexOf(argument.type) < 0) {
                        throw new Error('Invalid search criteria argument #' + (i + 1));
                    }
                    return argument.value;
                });
            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'UID SEARCH FAILED', parsed, data);
                return callback();
            }

            var messages = connection.selectedMailbox.messages,
                searchResult;

            try {
                searchResult = makeSearch(connection, messages, params);
            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'UID SEARCH FAILED', parsed, data);
                return callback();
            }

            if (searchResult && searchResult.list && searchResult.list.length) {
                connection.sendResponse({
                    tag: '*',
                    command: 'SEARCH',
                    attributes: searchResult.list.map(function(item) {
                        return item.uid;
                    })
                }, 'UID SEARCH', parsed, data);
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'UID SEARCH completed'
                }]
            }, 'UID SEARCH', parsed, data);
            return callback();
        },

        'UID STORE': function(connection, parsed, data, callback) {
            var storeHandlers = getStoreHandlers();

            if (!parsed.attributes ||
                parsed.attributes.length !== 3 ||
                !parsed.attributes[0] ||
                ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
                !parsed.attributes[1] ||
                (['ATOM'].indexOf(parsed.attributes[1].type) < 0) ||
                !parsed.attributes[2] ||
                !(['ATOM', 'STRING'].indexOf(parsed.attributes[2].type) >= 0 || Array.isArray(parsed.attributes[2]))
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'UID STORE expects sequence set, item name and item value'
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
                }, 'UID STORE FAILED', parsed, data);
                return callback();
            }

            var range = connection.server.getMessageRange(connection.selectedMailbox, parsed.attributes[0].value, true),
                itemName = (parsed.attributes[1].value || '').toUpperCase(),
                itemValue = [].concat(parsed.attributes[2] || []),
                affected = [];

            try {

                itemValue.forEach(function(item, i) {
                    if (!item || ['STRING', 'ATOM'].indexOf(item.type) < 0) {
                        throw new Error('Invalid item value #' + (i + 1));
                    }
                });

                range.forEach(function(rangeMessage) {

                    for (var i = 0, len = connection.server.storeFilters.length; i < len; i++) {
                        if (!connection.server.storeFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                            return;
                        }
                    }

                    var handler = connection.server.storeHandlers[itemName] || storeHandlers[itemName];
                    if (!handler) {
                        throw new Error('Invalid STORE argument ' + itemName);
                    }

                    handler(connection, rangeMessage[1], itemValue, rangeMessage[0], parsed, data);
                    affected.push(rangeMessage[1]);
                });

            } catch (E) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: E.message
                    }]
                }, 'UID STORE FAILED', parsed, data);
                return callback();
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'UID STORE completed'
                }]
            }, 'UID STORE COMPLETE', parsed, data, range);

            callback();
        },

        COPY: function(connection, parsed, data, callback) {

            if (!parsed.attributes ||
                parsed.attributes.length !== 2 ||
                !parsed.attributes[0] ||
                ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
                !parsed.attributes[1] ||
                ['ATOM', 'STRING'].indexOf(parsed.attributes[1].type) < 0
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'COPY expects sequence set and a mailbox name'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (['Selected'].indexOf(connection.state) < 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Select mailbox first'
                    }]
                }, 'COPY FAILED', parsed, data);
                return callback();
            }

            var sequence = parsed.attributes[0].value,
                path = parsed.attributes[1].value,
                mailbox = connection.server.getMailbox(path),
                range = connection.server.getMessageRange(connection.selectedMailbox, sequence, false);

            if (!mailbox) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Target mailbox does not exist'
                    }]
                }, 'COPY FAIL', parsed, data);
                return callback();
            }

            range.forEach(function(rangeMessage) {
                var message = rangeMessage[1],
                    flags = [].concat(message.flags || []),
                    internaldate = message.internaldate;

                connection.server.appendMessage(mailbox, flags, internaldate, message.raw, connection);
            });

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'COPY Completed'
                }]
            }, 'COPY', parsed, data);
            callback();
        },

        'UID COPY': function(connection, parsed, data, callback) {

            if (!parsed.attributes ||
                parsed.attributes.length !== 2 ||
                !parsed.attributes[0] ||
                ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
                !parsed.attributes[1] ||
                ['ATOM', 'STRING'].indexOf(parsed.attributes[1].type) < 0
            ) {

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'UID COPY expects sequence set and a mailbox name'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (['Selected'].indexOf(connection.state) < 0) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Select mailbox first'
                    }]
                }, 'UID COPY FAILED', parsed, data);
                return callback();
            }

            var sequence = parsed.attributes[0].value,
                path = parsed.attributes[1].value,
                mailbox = connection.server.getMailbox(path),
                range = connection.server.getMessageRange(connection.selectedMailbox, sequence, true);

            if (!mailbox) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Target mailbox does not exist'
                    }]
                }, 'COPY FAIL', parsed, data);
                return callback();
            }

            range.forEach(function(rangeMessage) {
                var message = rangeMessage[1],
                    flags = [].concat(message.flags || []),
                    internaldate = message.internaldate;

                connection.server.appendMessage(mailbox, flags, internaldate, message.raw, connection);
            });

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'UID COPY Completed'
                }]
            }, 'UID COPY', parsed, data);
            callback();
        },

        APPEND: function(connection, parsed, data, callback) {
            var args = [].concat(parsed.attributes || []),
                mailbox, path, flags, internaldate, raw;

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

            if (args.length > 4 || args.length < 2) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'APPEND takes 2 - 4 arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            path = args.shift();
            raw = args.pop();

            if (Array.isArray(args[0])) {
                flags = args.shift();
            }
            internaldate = args.shift();

            if (!path || ['STRING', 'ATOM'].indexOf(path.type) < 0 || !(mailbox = connection.server.getMailbox(path.value))) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Invalid mailbox argument'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (!raw || raw.type !== 'LITERAL') {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Invalid message source argument'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            if (flags) {
                for (var i = 0, len = flags.length; i < len; i++) {
                    if (!flags[i] || ['STRING', 'ATOM'].indexOf(flags[i].type) < 0) {
                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Invalid flags argument'
                            }]
                        }, 'INVALID COMMAND', parsed, data);
                        return callback();
                    }
                }
            }

            if (internaldate && (internaldate.type !== 'STRING' || !connection.server.validateInternalDate(internaldate.value))) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Invalid internaldate argument'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            connection.server.appendMessage(mailbox, (flags || []).map(function(flag) {
                return flag.value;
            }), internaldate && internaldate.value, raw.value, connection);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'APPEND Completed'
                }]
            }, 'APPEND', parsed, data);
            callback();
        },

        CHECK: function(connection, parsed, data, callback) {
            if (parsed.attributes) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'CHECK does not take any arguments'
                    }]
                }, 'INVALID COMMAND', parsed, data);
                return callback();
            }

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Completed'
                }]
            }, 'CHECK completed', parsed, data);

            callback();
        },

        CLOSE: function(connection, parsed, data, callback) {
            if (parsed.attributes) {
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [{
                        type: 'TEXT',
                        value: 'CLOSE does not take any arguments'
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
                        value: 'Select a mailbox first'
                    }]
                }, 'CLOSE FAILED', parsed, data);
                return callback();
            }

            connection.expungeDeleted(connection.selectedMailbox, true);

            connection.sendResponse({
                tag: parsed.tag,
                command: 'OK',
                attributes: [{
                    type: 'TEXT',
                    value: 'Mailbox closed'
                }]
            }, 'CLOSE', parsed, data);

            connection.state = 'Authenticated';
            connection.selectedMailbox = false;
            return callback();
        }
    };

    BrowserCrow.prototype.pluginHandlers = {
        XOAUTH2: function(server) {
            // Register capability, usable for non authenticated users
            server.registerCapability('AUTH=XOAUTH2', function(connection) {
                return connection.state === 'Not Authenticated';
            });

            server.setCommandHandler('AUTHENTICATE XOAUTH2', function(connection, parsed, data, callback) {

                // Not allowed if already logged in
                if (connection.state !== 'Not Authenticated') {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Already authenticated, identity change not allowed'
                        }]
                    }, 'AUTHENTICATE XOAUTH2 FAILED', parsed, data);
                    return callback();
                }

                if (!server.capabilities['SASL-IR'] || !server.capabilities['SASL-IR'](connection)) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'SASL-IR must be enabled to support XOAUTH2'
                        }]
                    }, 'AUTHENTICATE XOAUTH2 FAILED', parsed, data);
                    return callback();
                }

                if (parsed.attributes.length !== 1 ||
                    !parsed.attributes[0] ||
                    ['STRING', 'ATOM'].indexOf(parsed.attributes[0].type) < 0
                ) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'NO',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Invalid SASL argument'
                        }]
                    }, 'AUTHENTICATE XOAUTH2 FAILED', parsed, data);
                    return callback();
                }

                var parts = mimefuncs.base64Decode(parsed.attributes[0].value).split('\x01');
                var user = (parts[0] || '').substr(5);
                var accessToken = (parts[1] || '').substr(12);

                if (parts.length !== 4 ||
                    !parts[0].match(/^user\=/) ||
                    !parts[1].match(/^auth\=Bearer /) ||
                    !user || // Must be present
                    !accessToken || // Must be present
                    parts[2] || // Must be empty
                    parts[3] // Must be empty
                ) {

                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'NO',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Invalid SASL argument.'
                        }]
                    }, 'AUTHENTICATE XOAUTH2 FAILED', parsed, data);
                    return callback();
                }

                if (!connection.server.users.hasOwnProperty(user)) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'NO',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Invalid credentials'
                        }]
                    }, 'AUTHENTICATE XOAUTH2 FAILED', parsed, data);
                    return callback();
                }

                if (!connection.server.users.hasOwnProperty(user) ||
                    !connection.server.users[user].xoauth2 ||
                    connection.server.users[user].xoauth2.accessToken !== accessToken) {

                    connection.sendResponse({
                        tag: '+',
                        attributes: [{
                            type: 'ATOM',
                            value: mimefuncs.base64.encode(JSON.stringify({
                                'status': '400',
                                'schemes': 'Bearer',
                                'scope': 'https://mail.google.com/'
                            }))
                        }]
                    }, 'AUTHENTICATE XOAUTH2 FAILED', parsed, data);

                    // wait for response
                    connection.inputHandler = function() {
                        connection.inputHandler = false;
                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'NO',
                            attributes: [{
                                type: 'TEXT',
                                value: 'SASL authentication failed'
                            }]
                        }, 'AUTHENTICATE XOAUTH2 FAILED', parsed, data);
                    };
                } else {

                    connection.state = 'Authenticated';
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'OK',
                        attributes: [{
                            type: 'TEXT',
                            value: 'User logged in'
                        }]
                    }, 'AUTHENTICATE XOAUTH2 SUCCESS', parsed, data);

                }
                return callback();
            });
        },

        'SASL-IR': function(server) {
            server.registerCapability('SASL-IR', function(connection) {
                return connection.state === 'Not Authenticated';
            });
        },

        'SPECIAL-USE': function(server) {
            // Register capability
            server.registerCapability('SPECIAL-USE');

            var listHandler = server.getCommandHandler('LIST');

            server.setCommandHandler('LIST', function(connection, parsed, data, callback) {
                var i;
                if (parsed.attributes && Array.isArray(parsed.attributes[0])) {
                    for (i = parsed.attributes[0].length - 1; i >= 0; i--) {
                        if (parsed.attributes[0][i] && parsed.attributes[0][i].type === 'ATOM' &&
                            parsed.attributes[0][i].value.toUpperCase() === 'SPECIAL-USE') {

                            parsed.attributes[0].splice(i, 1);
                            parsed.listSpecialUseOnly = true;
                        }
                    }
                    // remove parameter if no other memebers were left
                    if (!parsed.attributes[0].length) {
                        parsed.attributes.splice(0, 1);
                    }
                }

                if (parsed.attributes && parsed.attributes[2] &&
                    parsed.attributes[2].type === 'ATOM' &&
                    parsed.attributes[2].value.toUpperCase() === 'RETURN' &&
                    Array.isArray(parsed.attributes[3])) {

                    for (i = parsed.attributes[3].length - 1; i >= 0; i--) {
                        if (parsed.attributes[3][i] && parsed.attributes[3][i].type === 'ATOM' &&
                            parsed.attributes[3][i].value.toUpperCase() === 'SPECIAL-USE') {

                            parsed.attributes[3].splice(i, 1);
                            parsed.listSpecialUseFlags = true;
                        }
                    }

                    // Remove RETURN (List) if no members were left
                    if (!parsed.attributes[3].length) {
                        parsed.attributes.splice(2, 2);
                    }
                }

                listHandler(connection, parsed, data, callback);
            });

            server.outputHandlers.push(function(connection, response, description, parsed, data, folder) {
                var specialUseList = [].concat(folder && folder['special-use'] || []).map(function(specialUse) {
                    return {
                        type: 'ATOM',
                        value: specialUse
                    };
                });

                if (
                    (description === 'LIST ITEM' || description === 'LSUB ITEM') &&
                    folder &&
                    response.attributes &&
                    Array.isArray(response.attributes[0])) {

                    if (folder['special-use'] && specialUseList.length) {
                        if (parsed.listSpecialUseFlags) {
                            // Show only special use flag
                            response.attributes[0] = specialUseList;
                        } else {
                            response.attributes[0] = response.attributes[0].concat(specialUseList);
                        }
                    } else {
                        if (parsed.listSpecialUseFlags) {
                            // No flags to display
                            response.attributes[0] = [];
                        }
                        if (parsed.listSpecialUseOnly) {
                            // Do not show this response
                            response.skipResponse = true;
                        }
                    }
                }
            });
        },

        ID: function(server) {
            // Register capability, always usable
            server.registerCapability('ID');

            // Add ID command
            server.setCommandHandler('ID', function(connection, parsed, data, callback) {
                var clientList = {},
                    serverList = null,
                    list, i, len, key;

                // Require exactly 1 attribute (NIL or parameter list)
                if (!parsed.attributes || parsed.attributes.length !== 1) {
                    return sendError('ID expects 1 attribute', connection, parsed, data, callback);
                }
                list = parsed.attributes[0];
                if (list && !Array.isArray(list) || (list && list.length % 2)) {
                    return sendError('ID expects valid parameter list', connection, parsed, data, callback);
                }

                // Build client ID object and check validity of the values
                if (list && list.length) {
                    for (i = 0, len = list.length; i < len; i++) {
                        if (i % 2 === 0) {
                            // Handle keys (always strings)
                            if (list[i] && ['STRING', 'LITERAL'].indexOf(list[i].type) >= 0) {
                                key = list[i].value;
                            } else {
                                return sendError('ID expects valid parameter list', connection, parsed, data, callback);
                            }
                        } else {
                            // Handle values (string or NIL)
                            if (!list[i] || ['STRING', 'LITERAL'].indexOf(list[i].type) >= 0) {
                                clientList[key] = list[i] && list[i].value || null;
                            } else {
                                return sendError('ID expects valid parameter list', connection, parsed, data, callback);
                            }
                        }
                    }
                }

                // Build response object from server options
                if (server.options.id) {
                    serverList = [];
                    Object.keys(server.options.id).forEach(function(key) {
                        serverList.push({
                            type: 'STRING',
                            value: key
                        });
                        serverList.push({
                            type: 'STRING',
                            value: (server.options.id[key] || '').toString()
                        });
                    });
                }

                // Send untagged ID response
                connection.sendResponse({
                    tag: '*',
                    command: 'ID',
                    attributes: [
                        serverList
                    ]
                }, 'ID', parsed, data, clientList);

                // Send tagged response
                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'OK',
                    attributes: [{
                        type: 'TEXT',
                        value: 'ID command completed'
                    }]
                }, 'ID', parsed, data, clientList);

                callback();
            });
        },

        UNSELECT: function(server) {
            server.registerCapability('UNSELECT');

            // Add ID command
            server.setCommandHandler('UNSELECT', function(connection, parsed, data, callback) {
                if (parsed.attributes) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'UNSELECT does not take any arguments'
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
                            value: 'Select a mailbox first'
                        }]
                    }, 'UNSELECT FAILED', parsed, data);
                    return callback();
                }

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'OK',
                    attributes: [{
                        type: 'TEXT',
                        value: 'Mailbox unselected'
                    }]
                }, 'UNSELECT', parsed, data);

                connection.state = 'Authenticated';
                connection.selectedMailbox = false;
                return callback();
            });
        },

        IDLE: function(server) {

            server.registerCapability('IDLE');

            server.setCommandHandler('IDLE', function(connection, parsed, data, callback) {
                if (connection.state === 'Not Authenticated') {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'NO',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Login first'
                        }]
                    }, 'INVALID COMMAND', parsed, data);
                    return callback();
                }

                if (parsed.attributes) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Unexpected arguments to IDLE'
                        }]
                    }, 'INVALID COMMAND', parsed, data);
                    return callback();
                }

                var idleTimer = setTimeout(function() {
                    if (connection._state === 'open') {
                        connection.sendResponse({
                            tag: '*',
                            command: 'BYE',
                            attributes: [{
                                type: 'TEXT',
                                value: 'IDLE terminated'
                            }]
                        }, 'IDLE EXPIRED', parsed, data);
                        connection.close();
                    }
                }, 30 * 60 * 1000);

                connection.directNotifications = true;

                // Temporarily redirect client input to this function
                connection.inputHandler = function(str) {
                    clearTimeout(idleTimer);

                    // Stop listening to any other user input
                    connection.inputHandler = false;
                    connection.directNotifications = false;

                    if (str.toUpperCase() === 'DONE') {
                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'OK',
                            attributes: [{
                                type: 'TEXT',
                                value: 'IDLE terminated'
                            }]
                        }, 'IDLE', parsed, data);
                    } else {
                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Invalid Idle continuation'
                            }]
                        }, 'INVALID IDLE', parsed, data);
                    }
                };

                if (connection._state === 'open') {
                    connection._ondata('+ idling\r\n');
                }

                connection.processNotifications();

                return callback();
            });
        },

        'AUTH=PLAIN': function(server) {

            // Register AUTH=PLAIN capability for non authenticated state
            server.registerCapability('AUTH=PLAIN', function(connection) {
                return connection.state === 'Not Authenticated';
            });

            server.setCommandHandler('AUTHENTICATE PLAIN', function(connection, parsed, data, callback) {

                // Not allowed if already logged in
                if (connection.state !== 'Not Authenticated') {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Already authenticated, identity change not allowed'
                        }]
                    }, 'AUTHENTICATE PLAIN FAILED', parsed, data);
                    return callback();
                }

                // If this is the old style api, send + and wait for password
                if (!parsed.attributes) {

                    // Temporarily redirect client input to this function
                    connection.inputHandler = function(str) {

                        // Stop listening to any other user input
                        connection.inputHandler = false;

                        var input = new Buffer(str, 'base64').toString().split('\x00'),
                            users = connection.server.users,
                            username = input[1] || '',
                            password = input[2] || '';

                        if (!users.hasOwnProperty(username) || users[username].password !== password) {
                            connection.sendResponse({
                                tag: parsed.tag,
                                command: 'NO',
                                attributes: [{
                                    type: 'TEXT',
                                    value: 'Login failed: authentication failure'
                                }]
                            }, 'AUTHENTICATE PLAIN FAILED', parsed, data);
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
                        }, 'AUTHENTICATE PLAIN SUCCESS', parsed, data);
                    };

                    // Send a + to the client
                    if (connection._state === 'open') {
                        connection._ondata('+\r\n');
                    }

                } else if (parsed.attributes.length === 1 &&
                    // second argument must be Base64 string as ATOM
                    parsed.attributes[0].type === 'ATOM') {

                    if (!server.capabilities['SASL-IR'] || !server.capabilities['SASL-IR'](connection)) {
                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'SASL-IR must be enabled to send Initial Response with the request'
                            }]
                        }, 'AUTHENTICATE PLAIN FAILED', parsed, data);
                        return callback();
                    }

                    var input = new Buffer(parsed.attributes[0].value, 'base64').toString().split('\x00'),
                        users = connection.server.users,
                        username = input[1] || '',
                        password = input[2] || '';

                    if (!users.hasOwnProperty(username) || users[username].password !== password) {
                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'NO',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Login failed: authentication failure'
                            }]
                        }, 'AUTHENTICATE PLAIN FAILED', parsed, data);
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
                    }, 'AUTHENTICATE PLAIN SUCCESS', parsed, data);

                } else {
                    // Not correct AUTH=PLAIN
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'Invalid attributes for AUTHENTICATE PLAIN'
                        }]
                    }, 'AUTHENTICATE PLAIN FAILED', parsed, data);
                }

                return callback();
            });
        },

        ENABLE: function(server) {

            server.registerCapability('ENABLE');

            server.enableAvailable = [];
            server.connectionHandlers.push(function(connection) {
                connection.enabled = [];
            });

            server.setCommandHandler('ENABLE', function(connection, parsed, data, callback) {
                var capability, i, len;

                if (['Authenticated'].indexOf(connection.state) < 0) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'ENABLE not allowed now.'
                        }]
                    }, 'ENABLE FAILED', parsed, data);
                    return callback();
                }

                if (!parsed.attributes) {
                    connection.sendResponse({
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [{
                            type: 'TEXT',
                            value: 'ENABLE expects capability list'
                        }]
                    }, 'INVALID COMMAND', parsed, data);
                    return callback();
                }

                for (i = 0, len = parsed.attributes.length; i < len; i++) {
                    if (parsed.attributes[i].type !== 'ATOM') {
                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Attribute nr ' + (i + 1) + ' is not an ATOM'
                            }]
                        }, 'INVALID COMMAND', parsed, data);
                        return callback();
                    }
                }

                for (i = 0, len = parsed.attributes.length; i < len; i++) {
                    capability = parsed.attributes[i].value.toUpperCase();
                    if (connection.enabled.indexOf(capability) < 0 && server.enableAvailable.indexOf(capability) >= 0) {
                        connection.enabled.push(capability);
                    }
                }

                connection.sendResponse({
                    tag: parsed.tag,
                    command: 'OK',
                    attributes: [{
                        type: 'TEXT',
                        value: 'ENABLE completed'
                    }]
                }, 'ENABLE', parsed, data);

                return callback();
            });
        },

        CONDSTORE: function(server) {

            // Register capability, always usable
            server.registerCapability('CONDSTORE');
            if (Array.isArray(server.enableAvailable)) {
                server.enableAvailable.push('CONDSTORE');
            }

            // set modseq values when message is created / initialized
            server.messageHandlers.push(function(connection, message, mailbox) {
                if (!message.MODSEQ) {
                    mailbox.HIGHESTMODSEQ = (mailbox.HIGHESTMODSEQ || 0) + 1;
                    message.MODSEQ = mailbox.HIGHESTMODSEQ;
                }
            });

            server.allowedStatus.push('HIGHESTMODSEQ');

            // Override SELECT and EXAMINE to add
            var selectHandler = server.getCommandHandler('SELECT'),
                examineHandler = server.getCommandHandler('EXAMINE'),
                closeHandler = server.getCommandHandler('CLOSE'),
                fetchHandler = server.getCommandHandler('FETCH'),
                uidFetchHandler = server.getCommandHandler('UID FETCH'),
                storeHandler = server.getCommandHandler('STORE'),
                uidStoreHandler = server.getCommandHandler('UID STORE'),

                condstoreHandler = function(prevHandler, connection, parsed, data, callback) {
                    if (hasCondstoreOption(parsed.attributes && parsed.attributes[1], parsed.attributes, 1)) {
                        connection.sessionCondstore = true;
                    } else if ('sessionCondstore' in connection) {
                        connection.sessionCondstore = false;
                    }
                    prevHandler(connection, parsed, data, callback);
                };

            server.setCommandHandler('SELECT', function(connection, parsed, data, callback) {
                condstoreHandler(selectHandler, connection, parsed, data, callback);
            });

            server.setCommandHandler('EXAMINE', function(connection, parsed, data, callback) {
                condstoreHandler(examineHandler, connection, parsed, data, callback);
            });

            server.setCommandHandler('CLOSE', function(connection, parsed, data, callback) {
                if ('sessionCondstore' in connection) {
                    connection.sessionCondstore = false;
                }
                closeHandler(connection, parsed, data, callback);
            });

            server.setCommandHandler('FETCH', function(connection, parsed, data, callback) {
                var changedsince = getCondstoreValue(parsed.attributes && parsed.attributes[2], 'CHANGEDSINCE', parsed.attributes, 2);

                if (changedsince) {
                    if (['ATOM', 'STRING'].indexOf(changedsince.type) < 0 ||
                        !changedsince.value.length ||
                        isNaN(changedsince.value) ||
                        Number(changedsince.value) < 0) {

                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Invalid syntax for CHANGEDSINCE, number expected'
                            }]
                        }, 'CONDSTORE FAILED', parsed, data);
                        return callback();
                    }
                    parsed.changedsince = Number(changedsince.value);
                }

                fetchHandler(connection, parsed, data, callback);
            });

            server.setCommandHandler('UID FETCH', function(connection, parsed, data, callback) {
                var changedsince = getCondstoreValue(parsed.attributes && parsed.attributes[2], 'CHANGEDSINCE', parsed.attributes, 2);

                if (changedsince) {
                    if (['ATOM', 'STRING'].indexOf(changedsince.type) < 0 ||
                        !changedsince.value.length ||
                        isNaN(changedsince.value) ||
                        Number(changedsince.value) < 0) {

                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Invalid syntax for CHANGEDSINCE, number expected'
                            }]
                        }, 'CONDSTORE FAILED', parsed, data);
                        return callback();
                    }
                    parsed.changedsince = Number(changedsince.value);
                }

                uidFetchHandler(connection, parsed, data, callback);
            });

            server.setCommandHandler('STORE', function(connection, parsed, data, callback) {
                var unchangedsince = getCondstoreValue(parsed.attributes && parsed.attributes[1], 'UNCHANGEDSINCE', parsed.attributes, 1);

                if (unchangedsince) {
                    if (['ATOM', 'STRING'].indexOf(unchangedsince.type) < 0 ||
                        !unchangedsince.value.length ||
                        isNaN(unchangedsince.value) ||
                        Number(unchangedsince.value) < 0) {

                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Invalid syntax for UNCHANGEDSINCE, number expected'
                            }]
                        }, 'CONDSTORE FAILED', parsed, data);
                        return callback();
                    }
                    parsed.unchangedsince = Number(unchangedsince.value);
                }

                storeHandler(connection, parsed, data, callback);
            });

            server.setCommandHandler('UID STORE', function(connection, parsed, data, callback) {
                var unchangedsince = getCondstoreValue(parsed.attributes && parsed.attributes[1], 'UNCHANGEDSINCE', parsed.attributes, 1);

                if (unchangedsince) {
                    if (['ATOM', 'STRING'].indexOf(unchangedsince.type) < 0 ||
                        !unchangedsince.value.length ||
                        isNaN(unchangedsince.value) ||
                        Number(unchangedsince.value) < 0) {

                        connection.sendResponse({
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [{
                                type: 'TEXT',
                                value: 'Invalid syntax for UNCHANGEDSINCE, number expected'
                            }]
                        }, 'CONDSTORE FAILED', parsed, data);
                        return callback();
                    }
                    parsed.unchangedsince = Number(unchangedsince.value);
                }

                uidStoreHandler(connection, parsed, data, callback);
            });

            server.pluginFetchHandlers.MODSEQ = function(connection, message) {
                return [message.MODSEQ]; // Must be a list
            };

            server.fetchFilters.push(function(connection, message, parsed) {
                return 'changedsince' in parsed ? parsed.changedsince < message.MODSEQ : true;
            });

            server.storeFilters.push(function(connection, message, parsed) {
                return 'unchangedsince' in parsed ? parsed.unchangedsince >= message.MODSEQ : true;
            });

            server.outputHandlers.push(function(connection, response, description, parsed, data, affected) {
                if (!parsed) {
                    return;
                }

                // Increase modseq if flags are updated
                if ((description === 'STORE COMPLETE' || description === 'UID STORE COMPLETE') && affected && affected.length) {
                    affected.forEach(function(message) {
                        message = Array.isArray(message) ? message[1] : message;
                        connection.selectedMailbox.HIGHESTMODSEQ = (connection.selectedMailbox.HIGHESTMODSEQ || 0) + 1;
                        message.MODSEQ = connection.selectedMailbox.HIGHESTMODSEQ;
                    });
                }

                // Add CONDSTORE info if (CONDSTORE) option was used
                if (description === 'EXAMINE' || description === 'SELECT') {

                    // (CONDSTORE) option was used, show notice
                    if (connection.sessionCondstore) {
                        if (response.attributes.slice(-1)[0].type !== 'TEXT') {
                            response.attributes.push({
                                type: 'TEXT',
                                value: 'CONDSTORE is now enabled'
                            });
                        } else {
                            response.attributes.slice(-1)[0].value += ', CONDSTORE is now enabled';
                        }
                    }

                    // Send untagged info about highest modseq
                    connection.sendResponse({
                        tag: '*',
                        command: 'OK',
                        attributes: [{
                            type: 'SECTION',
                            section: [{
                                    type: 'ATOM',
                                    value: 'HIGHESTMODSEQ'
                                },
                                connection.selectedMailbox.HIGHESTMODSEQ || 0
                            ]
                        }]
                    }, 'CONDSTORE INFO', parsed, data);
                }
            });
        }
    };

    function sendError(message, connection, parsed, data, callback) {
        connection.sendResponse({
            tag: parsed.tag,
            command: 'BAD',
            attributes: [{
                type: 'TEXT',
                value: message
            }]
        }, 'INVALID COMMAND', parsed, data);
        return callback();
    }

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

    function makeSearch(connection, messageSource, params) {
        var totalResults = [],

            nrCache = {},

            query,

            charset,

            queryParams = {
                'BCC': ['VALUE'],
                'BEFORE': ['VALUE'],
                'BODY': ['VALUE'],
                'CC': ['VALUE'],
                'FROM': ['VALUE'],
                'HEADER': ['VALUE', 'VALUE'],
                'KEYWORD': ['VALUE'],
                'LARGER': ['VALUE'],
                'NOT': ['COMMAND'],
                'ON': ['VALUE'],
                'OR': ['COMMAND', 'COMMAND'],
                'SENTBEFORE': ['VALUE'],
                'SENTON': ['VALUE'],
                'SENTSINCE': ['VALUE'],
                'SINCE': ['VALUE'],
                'SMALLER': ['VALUE'],
                'SUBJECT': ['VALUE'],
                'TEXT': ['VALUE'],
                'TO': ['VALUE'],
                'UID': ['VALUE'],
                'UNKEYWORD': ['VALUE']
            },

            composeQuery = function(params) {
                params = [].concat(params || []);

                var pos = 0,
                    param,
                    returnParams = [];

                var getParam = function(level) {
                    level = level || 0;
                    if (pos >= params.length) {
                        return undefined;
                    }

                    var param = params[pos++],
                        paramTypes = queryParams[param.toUpperCase()] || [],
                        paramCount = paramTypes.length,
                        curParams = [param.toUpperCase()];

                    if (paramCount) {
                        for (var i = 0, len = paramCount; i < len; i++) {
                            switch (paramTypes[i]) {
                                case 'VALUE':
                                    curParams.push(params[pos++]);
                                    break;
                                case 'COMMAND':
                                    curParams.push(getParam(level + 1));
                                    break;
                            }
                        }
                    }
                    return curParams;
                };

                while (typeof(param = getParam()) !== 'undefined') {
                    returnParams.push(param);
                }

                return returnParams;
            },

            searchFlags = function(flag, flagExists) {
                var results = [];
                messageSource.forEach(function(message, i) {
                    if (
                        (flagExists && message.flags.indexOf(flag) >= 0) ||
                        (!flagExists && message.flags.indexOf(flag) < 0)) {
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },

            searchHeaders = function(key, value, includeEmpty) {
                var results = [];
                key = (key || '').toString().toLowerCase();
                value = (value || '').toString();
                if (!value && !includeEmpty) {
                    return [];
                }

                messageSource.forEach(function(message, i) {
                    if (!message.parsed) {
                        message.parsed = mimeParser(message.raw || '');
                    }
                    var headers = (message.parsed.header || []),
                        parts,
                        lineKey, lineValue;

                    for (var j = 0, len = headers.length; j < len; j++) {
                        parts = headers[j].split(':');
                        lineKey = (parts.shift() || '').trim().toLowerCase();
                        lineValue = (parts.join(':') || '');

                        if (lineKey === key && (!value || lineValue.toLowerCase().indexOf(value.toLowerCase()) >= 0)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                            return;
                        }
                    }
                });
                return results;
            },

            queryHandlers = {
                '_SEQ': function(sequence) {
                    return connection.server.getMessageRange(messageSource, sequence).map(function(item) {
                        nrCache[item[1].uid] = item[0];
                        return item[1];
                    });
                },
                'ALL': function() {
                    return messageSource.map(function(message, i) {
                        nrCache[message.uid] = i + 1;
                        return message;
                    });
                },
                'ANSWERED': function() {
                    return searchFlags('\\Answered', true);
                },
                'BCC': function(value) {
                    return searchHeaders('BCC', value);
                },
                'BEFORE': function(date) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if (new Date(message.internaldate.substr(0, 11)).toISOString().substr(0, 10) < new Date(date).toISOString().substr(0, 10)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'BODY': function(value) {
                    var results = [];
                    value = (value || '').toString();
                    if (!value) {
                        return [];
                    }

                    messageSource.forEach(function(message, i) {
                        if (!message.parsed) {
                            message.parsed = mimeParser(message.raw || '');
                        }
                        if ((message.parsed.text || '').toLowerCase().indexOf(value.toLowerCase()) >= 0) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'CC': function(value) {
                    return searchHeaders('CC', value);
                },
                'DELETED': function() {
                    return searchFlags('\\Deleted', true);
                },
                'DRAFT': function() {
                    return searchFlags('\\Draft', true);
                },
                'FLAGGED': function() {
                    return searchFlags('\\Flagged', true);
                },
                'FROM': function(value) {
                    return searchHeaders('FROM', value);
                },
                'HEADER': function(key, value) {
                    return searchHeaders(key, value, true);
                },
                'KEYWORD': function(flag) {
                    return searchFlags(flag, true);
                },
                'LARGER': function(size) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if ((message.raw || '').length >= Number(size)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'NEW': function() {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if (message.flags.indexOf('\\Recent') >= 0 && message.flags.indexOf('\\Seen') < 0) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'NOT': function(q) {
                    if (!queryHandlers[q[0]] && q[0].match(/^[\d\,\:\*]+$/)) {
                        q.unshift('_SEQ');
                    } else if (!queryHandlers[q[0]]) {
                        throw new Error('NO Invalid query element: ' + q[0] + ' (Failure)');
                    }

                    var notResults = queryHandlers[q.shift()].apply(connection, q),
                        results = [];

                    messageSource.forEach(function(message, i) {
                        if (notResults.indexOf(message) < 0) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'OLD': function() {
                    return searchFlags('\\Recent', false);
                },
                'ON': function(date) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if (new Date(message.internaldate.substr(0, 11)).toISOString().substr(0, 10) === new Date(date).toISOString().substr(0, 10)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'OR': function(left, right) {
                    var jointResult = [],
                        leftResults, rightResults;

                    if (!queryHandlers[left[0]] && left[0].match(/^[\d\,\:\*]+$/)) {
                        left.unshift('_SEQ');
                    } else if (!queryHandlers[left[0]]) {
                        throw new Error('NO Invalid query element: ' + left[0] + ' (Failure)');
                    }

                    if (!queryHandlers[right[0]] && right[0].match(/^[\d\,\:\*]+$/)) {
                        right.unshift('_SEQ');
                    } else if (!queryHandlers[right[0]]) {
                        throw new Error('NO Invalid query element: ' + right[0] + ' (Failure)');
                    }

                    leftResults = queryHandlers[left.shift()].apply(connection, left);
                    rightResults = queryHandlers[right.shift()].apply(connection, right);

                    jointResult = jointResult.concat(leftResults);
                    rightResults.forEach(function(message) {
                        if (jointResult.indexOf(message) < 0) {
                            jointResult.push(message);
                        }
                    });

                    return jointResult;
                },
                'RECENT': function() {
                    return searchFlags('\\Recent', true);
                },
                'SEEN': function() {
                    return searchFlags('\\Seen', true);
                },
                'SENTBEFORE': function(date) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if (!message.parsed) {
                            message.parsed = mimeParser(message.raw || '');
                        }
                        var messageDate = message.parsed.parsedHeader.date || message.internaldate;
                        if (Object.prototype.toString.call(messageDate) !== '[object Date]') {
                            messageDate = new Date(messageDate.substr(0, 11));
                        }
                        if (messageDate.toISOString().substr(0, 10) < new Date(date).toISOString().substr(0, 10)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'SENTON': function(date) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if (!message.parsed) {
                            message.parsed = mimeParser(message.raw || '');
                        }
                        var messageDate = message.parsed.parsedHeader.date || message.internaldate;
                        if (Object.prototype.toString.call(messageDate) !== '[object Date]') {
                            messageDate = new Date(messageDate.substr(0, 11));
                        }
                        if (messageDate.toISOString().substr(0, 10) === new Date(date).toISOString().substr(0, 10)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'SENTSINCE': function(date) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if (!message.parsed) {
                            message.parsed = mimeParser(message.raw || '');
                        }
                        var messageDate = message.parsed.parsedHeader.date || message.internaldate;
                        if (Object.prototype.toString.call(messageDate) !== '[object Date]') {
                            messageDate = new Date(messageDate.substr(0, 11));
                        }
                        if (messageDate.toISOString().substr(0, 10) >= new Date(date).toISOString().substr(0, 10)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'SINCE': function(date) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if (new Date(message.internaldate.substr(0, 11)).toISOString().substr(0, 10) >= new Date(date).toISOString().substr(0, 10)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'SMALLER': function(size) {
                    var results = [];
                    messageSource.forEach(function(message, i) {
                        if ((message.raw || '').length < Number(size)) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'SUBJECT': function(value) {
                    return searchHeaders('SUBJECT', value);
                },
                'TEXT': function(value) {
                    var results = [];
                    value = (value || '').toString();
                    if (!value) {
                        return [];
                    }

                    messageSource.forEach(function(message, i) {
                        if ((message.raw || '').toString().toLowerCase().indexOf(value.toLowerCase()) >= 0) {
                            nrCache[message.uid] = i + 1;
                            results.push(message);
                        }
                    });
                    return results;
                },
                'TO': function(value) {
                    return searchHeaders('TO', value);
                },
                'UID': function(sequence) {
                    return connection.server.getMessageRange(messageSource, sequence, true).map(function(item) {
                        nrCache[item[1].uid] = item[0];
                        return item[1];
                    });
                },
                'UNANSWERED': function() {
                    return searchFlags('\\Answered', false);
                },
                'UNDELETED': function() {
                    return searchFlags('\\Deleted', false);
                },
                'UNDRAFT': function() {
                    return searchFlags('\\Draft', false);
                },
                'UNFLAGGED': function() {
                    return searchFlags('\\Flagged', false);
                },
                'UNKEYWORD': function(flag) {
                    return searchFlags(flag, false);
                },
                'UNSEEN': function() {
                    return searchFlags('\\Seen', false);
                }
            };

        Object.keys(connection.server.searchHandlers).forEach(function(key) {

            // if handler takes more than 3 params (mailbox, message, i), use the remaining as value params
            if (!(key in queryParams) && connection.server.searchHandlers[key].length > 3) {
                queryParams[key] = [];
                for (var i = 0, len = connection.server.searchHandlers[key].length - 3; i < len; i++) {
                    queryParams[key].push('VALUE');
                }
            }

            queryHandlers[key] = function() {
                var args = Array.prototype.slice.call(arguments),
                    results = [];

                // check all messages against the user defined function
                messageSource.forEach(function(message, i) {
                    if (connection.server.searchHandlers[key].apply(null, [connection, message, i + 1].concat(args))) {
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            };

        });

        // FIXME: charset is currently ignored
        if ((params[0] || '').toString().toUpperCase() === 'CHARSET') {
            params.shift(); // CHARSET
            charset = params.shift(); // value
        }

        query = composeQuery(params);
        query.forEach(function(q, i) {

            if (!queryHandlers[q[0]] && q[0].match(/^[\d\,\:\*]+$/)) {
                q.unshift('_SEQ');
            } else if (!queryHandlers[q[0]]) {
                throw new Error('NO Invalid query element: ' + q[0] + ' (Failure)');
            }

            var key = q.shift(),
                handler = queryHandlers[key],
                currentResult = handler && handler.apply(connection, q) || [];

            if (!i) {
                totalResults = [].concat(currentResult || []);
            } else {
                for (var j = totalResults.length - 1; j >= 0; j--) {
                    if (currentResult.indexOf(totalResults[j]) < 0) {
                        totalResults.splice(j, 1);
                    }
                }
            }
        });
        return {
            list: totalResults,
            numbers: nrCache
        };
    }

    function getStoreHandlers() {
        var storeHandlers = {};

        function checkSystemFlags(connection, flag) {
            if (flag.charAt(0) === '\\' && connection.server.systemFlags.indexOf(flag) < 0) {
                throw new Error('Invalid system flag ' + flag);
            }
        }

        function setFlags(connection, message, flags) {
            var messageFlags = [];
            [].concat(flags).forEach(function(flag) {
                flag = flag.value || flag;
                checkSystemFlags(connection, flag);

                // Ignore if it is not in allowed list and only permament flags are allowed to use
                if (connection.selectedMailbox.permanentFlags.indexOf(flag) < 0 && !connection.selectedMailbox.allowPermanentFlags) {
                    return;
                }

                if (messageFlags.indexOf(flag) < 0) {
                    messageFlags.push(flag);
                }
            });
            message.flags = messageFlags;
        }

        function addFlags(connection, message, flags) {
            [].concat(flags).forEach(function(flag) {
                flag = flag.value || flag;
                checkSystemFlags(connection, flag);

                // Ignore if it is not in allowed list and only permament flags are allowed to use
                if (connection.selectedMailbox.permanentFlags.indexOf(flag) < 0 && !connection.selectedMailbox.allowPermanentFlags) {
                    return;
                }

                if (message.flags.indexOf(flag) < 0) {
                    message.flags.push(flag);
                }
            });
        }

        function removeFlags(connection, message, flags) {
            [].concat(flags).forEach(function(flag) {
                flag = flag.value || flag;
                checkSystemFlags(connection, flag);

                if (message.flags.indexOf(flag) >= 0) {
                    for (var i = 0; i < message.flags.length; i++) {
                        if (message.flags[i] === flag) {
                            message.flags.splice(i, 1);
                            break;
                        }
                    }
                }
            });
        }

        function sendUpdate(connection, parsed, data, index, message) {
            var resp = [{
                    type: 'ATOM',
                    value: 'FLAGS'
                },
                message.flags.map(function(flag) {
                    return {
                        type: 'ATOM',
                        value: flag
                    };
                })
            ];

            if ((parsed.command || '').toUpperCase() === 'UID STORE') {
                resp.push({
                    type: 'ATOM',
                    value: 'UID'
                });
                resp.push(message.uid);
            }

            connection.sendResponse({
                tag: '*',
                attributes: [
                    index, {
                        type: 'ATOM',
                        value: 'FETCH'
                    },
                    resp
                ]
            }, 'FLAG UPDATE', parsed, data, message);
        }

        storeHandlers.FLAGS = function(connection, message, flags, index, parsed, data) {
            setFlags(connection, message, flags);
            sendUpdate(connection, parsed, data, index, message);
        };

        storeHandlers['+FLAGS'] = function(connection, message, flags, index, parsed, data) {
            addFlags(connection, message, flags);
            sendUpdate(connection, parsed, data, index, message);
        };

        storeHandlers['-FLAGS'] = function(connection, message, flags, index, parsed, data) {
            removeFlags(connection, message, flags);
            sendUpdate(connection, parsed, data, index, message);
        };

        storeHandlers['FLAGS.SILENT'] = function(connection, message, flags) {
            setFlags(connection, message, flags);
        };

        storeHandlers['+FLAGS.SILENT'] = function(connection, message, flags) {
            addFlags(connection, message, flags);
        };

        storeHandlers['-FLAGS.SILENT'] = function(connection, message, flags) {
            removeFlags(connection, message, flags);
        };

        return storeHandlers;
    }

    function hasCondstoreOption(attributes, parent, index) {
        if (!attributes) {
            return false;
        }
        var condstoreOption = false;
        if (Array.isArray(attributes)) {
            for (var i = attributes.length - 1; i >= 0; i--) {
                if (attributes[i] && attributes[i].type === 'ATOM' && attributes[i].value.toUpperCase() === 'CONDSTORE') {
                    attributes.splice(i, 1);
                    condstoreOption = true;
                    break;
                }
            }

            // remove parameter if no other memebers were left
            if (!attributes.length) {
                parent.splice(index, 1);
            }
        }
        return !!condstoreOption;
    }

    function getCondstoreValue(attributes, name, parent, index) {
        if (!attributes) {
            return false;
        }
        var condstoreValue = false;
        if (Array.isArray(attributes)) {
            for (var i = 0; i < attributes.length; i += 2) {
                if (attributes[i] && attributes[i].type === 'ATOM' && attributes[i].value.toUpperCase() === name.toUpperCase()) {
                    condstoreValue = attributes[i + 1];
                    attributes.splice(i, 2);
                    break;
                }
            }

            // remove parameter if no other memebers were left
            if (!attributes.length) {
                parent.splice(index, 1);
            }
        }

        return condstoreValue;
    }

    return BrowserCrow;
}));