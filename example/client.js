'use strict';

var server = new BrowserCrow({
    debug: false,
    storage: {
        'INBOX': {
            messages: [{
                raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                internaldate: '14-Sep-2013 21:22:28 -0300'
            }, {
                raw: 'Subject: hello 2\r\n\r\nWorld 2!',
                flags: ['\\Seen']
            }, {
                raw: 'Subject: hello 3\r\n\r\nWorld 3!'
            }, {
                raw: 'From: sender name <sender@example.com>\r\n' +
                    'To: Receiver name <receiver@example.com>\r\n' +
                    'Subject: hello 4\r\n' +
                    'Message-Id: <abcde>\r\n' +
                    'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n' +
                    '\r\n' +
                    'World 4!'
            }, {
                raw: 'Subject: hello 5\r\n\r\nWorld 5!'
            }, {
                raw: 'Subject: hello 6\r\n\r\nWorld 6!'
            }]
        },
        '': {
            'separator': '/',
            'folders': {
                '[Gmail]': {
                    'flags': ['\\Noselect'],
                    'folders': {
                        'All Mail': {
                            'special-use': '\\All'
                        },
                        'Drafts': {
                            'special-use': '\\Drafts'
                        },
                        'Important': {
                            'special-use': '\\Important'
                        },
                        'Sent Mail': {
                            'special-use': '\\Sent'
                        },
                        'Spam': {
                            'special-use': '\\Junk'
                        },
                        'Starred': {
                            'special-use': '\\Flagged'
                        },
                        'Trash': {
                            'special-use': '\\Trash'
                        }
                    }
                }
            }
        }
    }
});

var socket = server.connect();

socket.onopen = function() {
    log('Connection', 'opened');
};

socket.onclose = function() {
    log('Connection', 'closed');
};

socket.ondata = function(evt) {
    log('SERVER', evt.data);
};

socket.onerror = function(evt) {
    log('SERVER ERROR', evt.data);
};

document.getElementById('client-input-form').addEventListener('submit', function(e) {
    e.preventDefault();

    var data = document.getElementById('client-input-data').value;
    document.getElementById('client-input-data').value = '';

    log('CLIENT', data);
    socket.send(data + '\r\n');
}, false);

function log(type, str) {
    var box = document.getElementById('log');
    if (typeof str !== 'object' || !str) {
        box.value += type + ': ' + str.trim() + '\n';
    } else {
        box.value += type + ':\n' + (str.stack ? str.stack : JSON.stringify(str)) + '\n';
    }

    box.scrollTop = box.scrollHeight;
}