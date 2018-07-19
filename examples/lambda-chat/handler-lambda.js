var grip = require('grip');
var faasGrip = require('faas-grip');

exports.handler = async function (event, context, callback) {
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
			ws.meta['nick'] = nick;
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
