var grip = require('grip');
var faasGrip = require('faas-grip');

var processMessages(ws) {
	return new Promise(function (resolve) {
		if (!ws.canRecv() {
			resolve();
			return;
		}

		var message = ws.recv();

		// if return value is null, then the connection is closed
		if (message == null) {
			ws.close();
			resolve();
			return;
		}

		if (message.startsWith('/nick ')) {
			var nick = message.substring(6);
			ws.meta['nick'] = nick;
			ws.send('nickname set to [' + nick + ']');
			processMessages(ws).then(resolve());
			return;
		} else {
			// send the message to all clients
			var nick = ws.meta.nick || 'anonymous';
			faasGrip.publish(
				'room',
				new grip.WebSocketMessageFormat(nick + ': ' + message)
			).then(processMessages(ws).then(resolve()));
		}
	});
}

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

	processMessages(ws).then(function () {
		callback(null, ws.toResponse());
	});
};
