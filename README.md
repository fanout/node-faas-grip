# FaaS GRIP

Author: Justin Karneges <justin@fanout.io>

Function-as-a-service backends are not well-suited for handling long-lived connections, such as HTTP streams or WebSockets, because the function invocations are meant to be short-lived. The FaaS GRIP library makes it easy to delegate long-lived connection management to [Fanout Cloud](https://fanout.io/cloud/). This way, backend functions only need to be invoked when there is connection activity, rather than having to run for the duration of each connection.

This library is intended for use with [AWS Lambda](https://aws.amazon.com/lambda/) (with AWS API Gateway) or [Fly](https://fly.io/). Support for other FaaS backends may be added in the future.

## Setup for Lambda

Install this module:

```sh
npm install faas-grip
```

Set the `GRIP_URL` environment variable containing your Fanout Cloud settings, of the form:

```
https://api.fanout.io/realm/your-realm?iss=your-realm&key=base64:your-realm-key
```

Next, set up an API and resource in AWS API Gateway to point to your Lambda function, using a Lambda Proxy Integration. If you wish to support WebSockets, be sure to add `application/websocket-events` as a Binary media type.

Finally, edit the Fanout Cloud domain origin server (SSL) to point to the host and port of the AWS API Gateway Invoke URL.

Now whenever an HTTP request or WebSocket connection is made to your Fanout Cloud domain, your Lambda function will be able to control it.

## Setup for Fly

Create a `gripUrl` variable in `.fly.secrets.yml` containing your Fanout Cloud settings, of the form:

```yaml
gripUrl: https://api.fanout.io/realm/your-realm?iss=your-realm&key=base64:your-realm-key
```

Load the secret value in your `.fly.yml`:

```yaml
config:
  gripUrl:
    fromSecret: gripUrl
```

Early in your application code, set the `GRIP_URL` environment variable to its value:

```js
process.env.GRIP_URL = app.config.gripUrl;
```

Then, edit the Fanout Cloud domain origin server to point to the host and port of the Fly application (e.g. `{your-app}.edgeapp.net:80`).

Now whenever an HTTP request or WebSocket connection is made to your Fanout Cloud domain, your Fly application will be able to control it.

## Usage

### WebSockets

Fanout Cloud converts incoming WebSocket connection activity into a series of HTTP requests to your backend. The requests are formatted using WebSocket-over-HTTP protocol, which this library will parse for you.

When using Lambda, call `lambdaGetWebSocket` with the incoming Lambda event and it'll return a `WebSocketContext` object:

```js
var ws = faasGrip.lambdaGetWebSocket(event);
```

When using Fly, call `getWebSocket` with the incoming `Request` and it'll return a `WebSocketContext` object:

```js
var ws = await faasGrip.getWebSocket(event);
```

Note that unlike `lambdaGetWebSocket`, the `getWebSocket` function returns a promise (which you can await on in order to handle).

The `WebSocketContext` is a pseudo-socket object. You can call methods on it such as `accept()`, `send()`, `recv()`, and `close()`.

For example, here's a chat-like service for Lambda that accepts all connection requests, and any messages received are broadcasted out. Clients can choose a nickname by sending `/nick <name>`.

```js
var grip = require('grip');
var faasGrip = require('faas-grip');

exports.handler = function (event, context, callback) {
    var ws;
    try {
        ws = faasGrip.lambdaGetWebSocket(event);
    } catch (err) {
        callback(null, {
            statusCode: 400,
            headers: {'Content-Type': 'text/plain'},
            body: 'Not a WebSocket-over-HTTP request\n'
        });
        return;
    }

    // if this is a new connection, accept it and subscribe it to a channel
    if (ws.isOpening()) {
        ws.accept();
        ws.subscribe('room');
    }

    // here we loop over any messages
    while (ws.canRecv()) {
        var message = ws.recv();

        // if return value is null, then the connection is closed
        if (message == null) {
            ws.close();
            break;
        }

        if (message.startsWith('/nick ')) {
            var nick = message.substring(6);
            ws.meta.nick = nick;
            ws.send('nickname set to [' + nick + ']');
        } else {
            // send the message to all clients
            var nick = ws.meta.nick || 'anonymous';
            await faasGrip.publish(
                'room',
                new grip.WebSocketMessageFormat(nick + ': ' + message)
            );
        }
    }

    callback(null, ws.toResponse());
};
```

To do the same on Fly, change how the request and response parts are handled:

```js
var grip = require('grip');
var faasGrip = require('faas-grip');

process.env.GRIP_URL = app.config.gripUrl;

addEventListener('fetch', function (event) {
    var ws = await faasGrip.getWebSocket(event.request);

    // ... inner websocket handling code here

    event.respondWith(ws.toResponse());
})
```

The while loop is deceptive. It looks like it's looping for the lifetime of the WebSocket connection, but what it's really doing is looping through a batch of WebSocket messages that was just received via HTTP. Often this will be one message, and so the loop performs one iteration and then exits. Similarly, the `ws` object only exists for the duration of the handler invocation, rather than for the lifetime of the connection as you might expect. It may look like socket code, but it's all an illusion. :tophat:

Note: it's important that your function doesn't finish before `publish` has also finished. An easy way to handle this is to await the `publish` call.

### HTTP streaming

To serve an HTTP streaming connection, respond with `Grip-Hold` and `Grip-Channel` headers. Here's an example for Lambda:

```js
exports.handler = function (event, context, callback) {
    callback(null, {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/plain',
            'Grip-Hold': 'stream',
            'Grip-Channel': 'mychannel'
        },
        body: 'stream opened, prepare yourself!\n'
    });
};
```

This will return some initial data to the client and leave the connection open, subscribed to `mychannel`.

To publish data:

```js
var grip = require('grip');
var faasGrip = require('faas-grip');

await faasGrip.publish('mychannel', new grip.HttpStreamFormat('some data\n'));
```

### HTTP long-polling

To hold a request open as a long-polling request, respond with `Grip-Hold` and `Grip-Channel` headers. Here's an example for Lambda:

```js
exports.handler = function (event, context, callback) {
    callback(null, {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/plain',
            'Grip-Hold': 'response',
            'Grip-Channel': 'mychannel'
        },
        body: 'request timed out\n'
    });
};
```

This will hang the request until data is published to the channel, or until the request times out. On timeout, the response will be released to the client.

To publish data:

```js
var grip = require('grip');
var faasGrip = require('faas-grip');

await faasGrip.publish('mychannel', new grip.HttpResponseFormat('some data\n'));
```

# Resources

* [Generic Realtime Intermediary Protocol](http://pushpin.org/docs/protocols/grip/)
* [WebSocket-over-HTTP protocol](http://pushpin.org/docs/protocols/websocket-over-http/)
