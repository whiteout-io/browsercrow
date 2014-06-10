'use strict';

if (typeof define !== 'function') {
    var define = require('amdefine')(module);
}

define(function(require) {

    var chai = require('chai');
    var BrowserBox = require('browserbox');
    var BrowserCrow = require('browsercrow');

    var expect = chai.expect;
    chai.Assertion.includeStack = true;

    describe('browsercrow integration tests', function() {
        var client, server;
        beforeEach(function(done) {
            server = new BrowserCrow({
                debug: false
            });

            client = new BrowserBox(false, false, {
                auth: {
                    user: "testuser",
                    pass: "demo"
                },
                useSSL: false
            });
            client.client._TCPSocket = server.createTCPSocket();

            expect(client).to.exist;

            client.onauth = done;
            client.onerror = done;
            client.connect();
        });

        afterEach(function(done) {
            client.close();
            done();
        });

        describe('#listMailboxes', function() {
            it('should succeed', function(done) {
                client.listMailboxes(function(err, mailboxes) {
                    expect(err).to.not.exist;
                    expect(mailboxes).to.not.be.empty;
                    done();
                });
            });
        });
    });
});