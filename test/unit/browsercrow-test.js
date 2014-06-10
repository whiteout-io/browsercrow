'use strict';

if (typeof define !== 'function') {
    var define = require('amdefine')(module);
}

define(function(require) {

    var chai = require('chai');
    var sinon = require('sinon');
    var BrowserCrow = require('browsercrow');

    var expect = chai.expect;
    chai.Assertion.includeStack = true;

    describe('browsercrow unit tests', function() {
        /* jshint indent:false */

        describe('#_onClose', function() {
            it('should emit onclose', function(done) {
                var server = new BrowserCrow();
                sinon.stub(server, 'indexFolders');
                var connection = server.connect();

                sinon.stub(connection, '_ondata', function(data) {
                    expect(data).to.equal('* OK BrowserCrow ready for rumble\r\n');
                    done();
                });

                connection.onopen = function(e) {
                    expect(e.type).to.equal('open');
                };
            });
        });
    });
});