(function(root, factory) {
    'use strict';

    if (typeof define === 'function' && define.amd) {
        define(function() {
            return factory();
        });
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        root.envelope = factory();
    }
}(this, function() {
    'use strict';

    function processAddress(arr, def) {
        arr = [].concat(arr || []);
        if (!arr.length) {
            arr = [].concat(def || []);
        }
        if (!arr.length) {
            return null;
        }
        var result = [];
        arr.forEach(function(addr) {
            if (!addr.group) {
                result.push([
                    addr.name || null,
                    null, // FIXME: check the rfc, this should be related to groups
                    (addr.address || '').split('@').shift() || null, (addr.address || '').split('@').pop() || null
                ]);
            } else {
                // Handle group syntax
                result.push([null, null, addr.name || '', null]);
                result = result.concat(processAddress(addr.group) || []);
                result.push([null, null, null, null]);
            }
        });

        return result;
    }

    return function(header) {
        return [
            header.date || null,
            header.subject || '',
            processAddress(header.from),
            processAddress(header.sender, header.from),
            processAddress(header['reply-to'], header.from),
            processAddress(header.to),
            processAddress(header.cc),
            processAddress(header.bcc),
            // If this is an embedded MESSAGE/RFC822, then Gmail seems to
            // have a bug here, it states ''NIL'' as the value, not 'NIL'
            header['in-reply-to'] || null,
            header['message-id'] || null
        ];
    };


}));