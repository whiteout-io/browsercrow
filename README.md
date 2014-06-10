browsercrow
===========

Incredibly hacky IMAP integration test server in the browser. This is a port of [Hoodiecrow](http://www.hoodiecrow.com).

See demo [here](http://tahvel.info/browsercrow/example/client.html).

### Hook BrowserCrow server with BrowserBox

Create server instance

    server = new BrowserCrow({});

Create client instance

    client = new BrowserBox(false, false, {
        auth: {
            user: "testuser",
            pass: "demo"
        },
        useSSL: false
    });

Replace TCPSocket constructor with a mock object from the server

    client.client._TCPSocket = server.createTCPSocket();

Connect to the server and start hacking

    client.connect();

Thats it!