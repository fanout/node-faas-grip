/*
 * node-faas-grip
 * FaaS GRIP library for NodeJS.
 * (C) 2017-2018 Fanout, Inc.
 * File name: faas-grip.js
 * File contains: the GRIP interface functionality.
 * File authors: 
 * Justin Karneges <justin@fanout.io>
 * Licensed under the MIT License, see file COPYING for details.
 */

var jspack = require('jspack').jspack;
var pubcontrol = require('pubcontrol');
var grip = require('grip');

var pubControl = null;

var getProxies = function () {
	var proxies = [];
	var gripProxies = process.env.GRIP_PROXIES || [];
	for (var n = 0; n < gripProxies.length; ++n) {
		proxies.push(gripProxies[n]);
	}
	var gripUrl = process.env.GRIP_URL;
	if (gripUrl) {
		proxies.push(grip.parseGripUri(gripUrl));
	}
	return proxies;
};

var getPubControl = function () {
	if (pubControl == null) {
		pubControl = new grip.GripPubControl();
		pubControl.applyGripConfig(getProxies());
	}
	return pubControl;
};

var getPrefix = function () {
	return process.env.GRIP_PREFIX || '';
};

var publish = function (channel, formats, id, prev_id) {
	return new Promise(function (fulfill, reject) {
		var pubControl = getPubControl();
		pubControl.publish(
			getPrefix() + channel,
			new pubcontrol.Item(formats, id, prev_id),
			function (success, message, context) {
				if (success) {
					fulfill();
				} else {
					reject({
						message: message,
						context: context
					});
				}
			}
		);
	});
};

var prepareResponse = function (wsContext) {
	// meta to remove?
	var metaRemove = [];
	for (var key in wsContext.origMeta) {
		if (wsContext.origMeta.hasOwnProperty(key)) {
			var found = false;
			for (var nkey in wsContext.meta) {
				if (wsContext.meta.hasOwnProperty(nkey)) {
					if (nkey.toLowerCase() == key) {
						found = true;
						break;
					}
				}
			}
			if (!found) {
				metaRemove.push(key);
			}
		}
	}

	// meta to set?
	var metaSet = {};
	for (var key in wsContext.meta) {
		if (wsContext.meta.hasOwnProperty(key)) {
			var lname = key.toLowerCase();
			var v = wsContext.meta[key];
			var needSet = true;
			for (var okey in wsContext.origMeta) {
				if (wsContext.origMeta.hasOwnProperty(okey)) {
					if (lname == okey && v == wsContext.origMeta[okey]) {
						needSet = false;
						break;
					}
				}
			}
			if (needSet) {
				metaSet[lname] = wsContext.meta[key];
			}
		}
	}

	var events = [];
	if (wsContext.accepted) {
		events.push(new grip.WebSocketEvent('OPEN'));
	}
	for (var n = 0; n < wsContext.outEvents.length; ++n) {
		events.push(wsContext.outEvents[n]);
	}
	if (wsContext.closed) {
		events.push(new grip.WebSocketEvent('CLOSE', jspack.Pack('>H', [wsContext.outCloseCode])));
	}

	var headers = {'Content-Type': 'application/websocket-events'};
	if (wsContext.accepted) {
		headers['Sec-WebSocket-Extensions'] = 'grip';
	}
	for(var n = 0; n < metaRemove.length; ++n) {
		headers['Set-Meta-' + metaRemove[n]] = '';
	}
	for(var key in metaSet) {
		if (metaSet.hasOwnProperty(key)) {
			headers['Set-Meta-' + key] = metaSet[key];
		}
	}

	var body = grip.encodeWebSocketEvents(events);

	return { headers: headers, body: body };
}

var lambdaWebSocketToResponse = function (wsContext) {
	var resp = prepareResponse(wsContext);

	return {
		isBase64Encoded: true,
		statusCode: 200,
		headers: resp.headers,
		body: resp.body.toString('base64')
	}
};

var lambdaGetWebSocket = function (event) {
	var headers = event.headers || {};
	var lowerHeaders = {};
	for (var key in headers) {
		if (headers.hasOwnProperty(key)) {
			lowerHeaders[key.toLowerCase()] = headers[key];
		}
	}

	var contentType = lowerHeaders['content-type'];
	if (contentType !== undefined) {
		var at = contentType.indexOf(';');
		if (at >= 0) {
			contentType = contentType.substring(0, at);
		}
	}

	if (event.httpMethod != 'POST' || contentType != 'application/websocket-events') {
		throw 'request does not seem to be a websocket-over-http request';
	}

	var cid = lowerHeaders['connection-id'];

	var meta = {};
	for (var key in lowerHeaders) {
		if (lowerHeaders.hasOwnProperty(key)) {
			if (key.indexOf('meta-') == 0) {
				meta[key.substring(5)] = lowerHeaders[key];
			}
		}
	}

	// read body as binary
	var body;
	if (event.isBase64Encoded) {
		body = new Buffer(event.body, 'base64');
	} else {
		body = new Buffer(event.body);
	}

	var events = grip.decodeWebSocketEvents(body);

	var wsContext = new grip.WebSocketContext(cid, meta, events, getPrefix());

	wsContext.toResponse = function () { return lambdaWebSocketToResponse(wsContext); };

	return wsContext;
};

var webSocketToResponse = function (wsContext) {
	var resp = prepareResponse(wsContext);

	return new Response(resp.body.buffer, {
		status: 200,
		headers: resp.headers
	});
};

var getWebSocket = function (request) {
	return new Promise(function (fulfill, reject) {
		var contentType = request.headers.get('Content-Type');
		if (contentType) {
			var at = contentType.indexOf(';');
			if (at >= 0) {
				contentType = contentType.substring(0, at);
			}
		}

		if (request.method != 'POST' || contentType != 'application/websocket-events') {
			reject('request does not seem to be a websocket-over-http request');
			return;
		}

		var cid = request.headers.get('Connection-Id');

		var meta = {};
		for (var pair of request.headers) {
			if (pair[0].indexOf('meta-') == 0) {
				meta[pair[0].substring(5)] = pair[1];
			}
		}

		request.arrayBuffer().then(function (body) {
			var events = grip.decodeWebSocketEvents(Buffer.from(body));

			var wsContext = new grip.WebSocketContext(cid, meta, events, getPrefix());

			wsContext.toResponse = function () { return webSocketToResponse(wsContext); };

			fulfill(wsContext);
		}, function (err) {
			reject('error while reading request body: ' + err.message);
		});
	});
};

exports.getPubControl = getPubControl;
exports.publish = publish;
exports.lambdaGetWebSocket = lambdaGetWebSocket;
exports.getWebSocket = getWebSocket;
