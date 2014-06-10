(function(factory) {
    'use strict';

    if (typeof define === 'function' && define.amd && typeof exports === 'undefined') {
        // amd under chrome packaged app
        define([], factory());
    } else if (typeof define === 'function' && define.amd && typeof exports === 'object') {
        // amd under node-webkit
        define([], factory());
    } else if (typeof exports === 'object') {
        // node.js
        module.exports = factory();
    } else {
        // global browser import
        this.TCPSocket = factory();
    }
}(function() {
    'use strict';

    // the class to be implemented
    var TCPSocket = function() {};

    return TCPSocket;
}));