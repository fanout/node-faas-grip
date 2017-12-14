/*
 * node-faas-grip
 * FaaS GRIP library for NodeJS.
 * (C) 2017 Fanout, Inc.
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

var extend = function() {
	var args = Array.prototype.slice.call(arguments);

	var obj;
	if (args.length > 1) {
		obj = args.shift();
	} else {
		obj = {};
	}

	while(args.length > 0) {
		var opts = args.shift();
		if(opts != null) {
			for(prop in opts) {
				obj[prop] = opts[prop];
			}
		}
	}

	return obj;
};

var extendClass = function(prototype) {
	var constructor, properties;
	var argc = arguments.length;
	if (argc >= 3) {
		constructor = arguments[1];
		properties = arguments[2];
	} else if (argc == 2) {
		var arg = arguments[1];
		if(isFunction(arg)) {
			constructor = arg;
			properties = null;
		} else {
			constructor = function(){};
			properties = arg;
		}
	} else if (argc == 1) {
		constructor = function(){};
		properties = null;
	}

	if (isFunction(prototype)) {
		prototype = new prototype();
	}

	if(prototype) {
		constructor.prototype = prototype;
	}
	if(properties) {
		extend(constructor.prototype, properties);
	}
	return constructor;
};

var defineClass = function() {
	var args = [null].concat(Array.prototype.slice.call(arguments));
	return extendClass.apply(this, args);
};

var objectToString = Object.prototype.toString;
var functionObjectIdentifier = objectToString.call(function(){});
var isFunction = function (obj) {
	return obj && objectToString.call(obj) === functionObjectIdentifier;
};

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

var publish = function (channel, formats, id, prev_id, cb) {
	if (isFunction(id)) {
		cb = id;
		id = undefined;
		prevId = undefined;
	}
	var pubControl = getPubControl();
	pubControl.publish(getPrefix() + channel, new pubcontrol.Item(
			formats, id, prev_id), cb);
}

var WebSocketContext = defineClass(function(id, meta, inEvents, prefix) {
	this.id = id;
	this.inEvents = inEvents;
	this.readIndex = 0;
	this.accepted = false;
	this.closeCode = null;
	this.closed = false;
	this.outCloseCode = null;
	this.outEvents = [];
	this.origMeta = meta;
	this.meta = JSON.parse(JSON.stringify(meta));
	this.prefix = '';
	if (prefix) {
		this.prefix = prefix;
	}
}, {
	isOpening: function() { return this.inEvents != null &&
			this.inEvents.length > 0 && this.inEvents[0].type == 'OPEN'; },
	accept: function() { this.accepted = true; },
	close: function(code) {
		this.closed = true;
		if (code !== undefined) {
			this.outCloseCode = code;
		} else {
			this.outCloseCode = 0;
		}
	},
	canRecv: function() {
		for (n = this.readIndex; n < this.inEvents.length; n++) {
			if (['TEXT', 'BINARY', 'CLOSE', 'DISCONNECT'].indexOf(
					this.inEvents[n].type) > -1) {
				return true;
			}
		}
		return false;
	},
	recvRaw: function() {
		var e = null;
		while (e == null && this.readIndex < this.inEvents.length) {
			if (['TEXT', 'BINARY', 'CLOSE', 'DISCONNECT'].indexOf(
					this.inEvents[this.readIndex].type) > -1) {
				e = this.inEvents[this.readIndex];
			} else if (this.inEvents[this.readIndex].type == 'PING') {
				this.outEvents.push(new grip.WebSocketEvent('PONG'));
			}
			this.readIndex += 1;
		}
		if (e == null) {
			throw new Error('Read from empty buffer.');
		}
		if (e.type == 'TEXT') {
			if (e.content) {
				return e.content.toString();
			} else {
				return '';
			}
		} else if (e.type == 'BINARY') {
			if (e.content) {
				return e.content;
			} else {
				return new Buffer(0);
			}
		} else if (e.type == 'CLOSE') {
			if (e.content && e.content.length == 2) {
				this.closeCode = jspack.Unpack('>H', [e.content[0],
					e.content[1]])[0];
			}
			return null;
		} else {
			throw new Error('Client disconnected unexpectedly.');
		}
	},
	recv: function() {
		var result = this.recvRaw();
		if (result == null) {
			return null;
		} else {
			return result.toString();
		}
	},
	send: function(message) {
		this.outEvents.push(new grip.WebSocketEvent('TEXT', Buffer.concat(
				[new Buffer('m:'), new Buffer(message)])));
	},
	sendBinary: function(message) {
		this.outEvents.push(new grip.WebSocketEvent('BINARY', Buffer.concat(
				[new Buffer('m:'), new Buffer(message)])));
	},
	sendControl: function(message) {
		this.outEvents.push(new grip.WebSocketEvent('TEXT', Buffer.concat(
				[new Buffer('c:'), new Buffer(message)])));
	},
	subscribe: function(channel) {
		this.sendControl(grip.webSocketControlMessage('subscribe',
				{'channel': this.prefix + channel}));
	},
	unsubscribe: function(channel) {
		this.sendControl(grip.webSocketControlMessage('unsubscribe',
				{'channel': this.prefix + channel}));
	},
	detach: function() {
		this.sendControl(grip.webSocketControlMessage('detach'));
	}
});

var lambdaWebSocketToResponse = function (wsContext) {
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
		events.push(new grip.WebSocketEvent('CLOSE', jspack.Pack('>H', wsContext.outCloseCode)));
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

	return {
		isBase64Encoded: true,
		statusCode: 200,
		headers: headers,
		body: body.toString('base64')
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

	var wsContext = new WebSocketContext(cid, meta, events, getPrefix());

	wsContext.toResponse = function () { return lambdaWebSocketToResponse(wsContext); };

	return wsContext;
};

exports.WebSocketContext = WebSocketContext;
exports.getPubControl = getPubControl;
exports.publish = publish;
exports.lambdaGetWebSocket = lambdaGetWebSocket;
