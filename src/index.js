const net = require('net');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const url = require('url');
const semaphore = require('semaphore');
const compose = require('koa-compose');
const Koa = require('koa');

const ca = require('./certs');
const clientEndMiddleware = require('./middleware/client-side/client-end');
const serverEndMiddleware = require('./middleware/server-side/server-end');
const gunzipMiddleware = require('./middleware/server-side/gunzip');
const summaryMiddleware = require('./middleware/client-side/summary');
const clientProxyMiddleware = require('./middleware/client-side/proxy');
const serverProxyMiddleware = require('./middleware/server-side/proxy');

/**
 * *Vanessa Core*
 * 
 * Vanessa Core contains a customized class derived from Koa, and
 * part of the builtin middleware that is required for a practical
 * man-in-the-middle proxy.
 * 
 * This part of middleware is divided into client-side and server-
 * side.
 * 
 * The whole middleware stack is composed by client-side middleware
 * at bottom, middleware provided with Vanessa#use() in the middle,
 * and server-side middleware at the top.
 */
const composeMiddleware = (middleware) => [

    // Initialize the context and request options
    clientEndMiddleware,

    // Initialize the proxy-chaining options
    // and detect system proxy settings as default
    clientProxyMiddleware,

    // Print logs for requests and responses
    summaryMiddleware,

    // Middleware provided by user
    ...middleware,

    // Accept responses in gzip encoding and decode them in advance
    gunzipMiddleware,

    // Use proxy-chaining options to prepare requests through a remote proxy
    serverProxyMiddleware,

    // Make requests and awaiting for responses
    serverEndMiddleware
];

module.exports = class Vanessa extends Koa {
    listen(...args) {
        this.sslServers = {};
        this.sslSemaphores = {};
        this.connectRequests = {};
        this.httpServer = http.createServer();
        this.httpServer.on('connect', this._onHttpServerConnect.bind(this));
        this.httpServer.on('request', this._onHttpServerRequest.bind(this, false));
        this.wsServer = new WebSocket.Server({ server: this.httpServer });
        this.wsServer.on('error', (e) => this.emit('error', e));
        this.wsServer.on('connection', (ws, req) => {
            ws.upgradeReq = req;
            this._onWebSocketServerConnect.call(this, false, ws, req);
        });

        return this.httpServer.listen(...args);
    }

    close() {
        this.httpServer.close();
        delete this.httpServer;
        if (this.httpsServer) {
            this.httpsServer.close();
            delete this.httpsServer;
            delete this.wssServer;
            delete this.sslServers;
        }
        if (this.sslServers) {
            Object.keys(this.sslServers).forEach((srvName) => {
                let server = this.sslServers[srvName].server;
                if (server) server.close();
                delete this.sslServers[srvName];
            });
        }
        return this;
    }

    _onHttpServerConnect(req, socket, head) {
        // we need first byte of data to detect if request is SSL encrypted
        if (!head || head.length === 0) {
            socket.once('data', this._onHttpServerConnectData.bind(this, req, socket));
            socket.write('HTTP/1.1 200 OK\r\n');
            return socket.write('\r\n');
        } else {
            this._onHttpServerConnectData(req, socket, head);
        }
    }

    _onHttpServerConnectData(req, socket, head) {
        const makeConnection = (port) => {
            // open a TCP connection to the remote host
            let conn = net.connect(
                {
                    port: port,
                    allowHalfOpen: true
                },
                () => {
                    // create a tunnel between the two hosts
                    conn.on('finish', () => {
                        socket.destroy();
                    });
                    let connectKey = conn.localPort + ':' + conn.remotePort;
                    this.connectRequests[connectKey] = req;
                    socket.pipe(conn);
                    conn.pipe(socket);
                    socket.emit('data', head);
                    conn.on('end', () => {
                        delete this.connectRequests[connectKey];
                    });
                    return socket.resume();
                }
            );
            conn.on('error', (err) => {
                if (err.code !== 'ECONNRESET') {
                    this.emit('error', err);
                }
            });
            socket.on('error', (err) => {
                if (err.code !== 'ECONNRESET') {
                    this.emit('error', err);
                }
            });
        };

        socket.pause();

        /*
        * Detect TLS from first bytes of data
        * Inspired from https://gist.github.com/tg-x/835636
        * used heuristic:
        * - an incoming connection using SSLv3/TLSv1 records should start with 0x16
        * - an incoming connection using SSLv2 records should start with the record size
        *   and as the first record should not be very big we can expect 0x80 or 0x00 (the MSB is a flag)
        * - everything else is considered to be unencrypted
        */
        if (head[0] == 0x16 || head[0] == 0x80 || head[0] == 0x00) {
            // URL is in the form 'hostname:port'
            let hostname = req.url.split(':', 2)[0];
            let sslServer = this.sslServers[hostname];
            if (sslServer) {
                return makeConnection(sslServer.port);
            }
            let wildcardHost = hostname.replace(/[^\.]+\./, '*.');
            let sem = this.sslSemaphores[wildcardHost];
            if (!sem) {
                sem = this.sslSemaphores[wildcardHost] = semaphore(1);
            }
            sem.take(() => {
                if (this.sslServers[hostname]) {
                    process.nextTick(sem.leave.bind(sem));
                    return makeConnection(this.sslServers[hostname].port);
                }
                if (this.sslServers[wildcardHost]) {
                    process.nextTick(sem.leave.bind(sem));
                    this.sslServers[hostname] = {
                        port: this.sslServers[wildcardHost]
                    };
                    return makeConnection(this.sslServers[hostname].port);
                }

                let options = Object.assign(
                    {
                        hosts: [hostname]
                    },
                    ca[hostname]
                );

                let httpsServer = https.createServer(options);
                httpsServer.on('error', (e) => this.emit('error', e));
                httpsServer.on('clientError', (e) => this.emit('error', e));
                httpsServer.on('connect', this._onHttpServerConnect.bind(this));
                httpsServer.on('request', this._onHttpServerRequest.bind(this, true));
                let wssServer = new WebSocket.Server({ server: httpsServer });
                wssServer.on('connection', (ws, req) => {
                    ws['upgradeReq'] = req;
                    this._onWebSocketServerConnect.call(this, true, ws, req);
                });
                httpsServer.listen(
                    {
                        port: 0,
                        host: this.httpServer.address().address
                    },
                    () => {
                        let sslServer = {
                            server: httpsServer,
                            wsServer: wssServer,
                            port: httpsServer.address()['port']
                        };
                        this.sslServers[hostname] = sslServer;
                        process.nextTick(sem.leave.bind(sem));
                        makeConnection(sslServer.port);
                    }
                );
            });
        } else {
            return makeConnection(this.httpServer.address()['port']);
        }
    }

    _onHttpServerRequest(isSSL, req, res) {
        const fn = compose(composeMiddleware(this.middleware));
        if (!this.listenerCount('error')) this.on('error', this.onerror);

        const ctx = this.createContext(req, res);
        const protocol = isSSL ? 'https' : 'http';

        ctx.rawRequest = this.connectRequests[req.socket.remotePort + ':' + req.socket.localPort] || req;

        Object.defineProperties(ctx.request, {
            protocol: {
                get() {
                    return protocol;
                }
            },
            ip: {
                get() {
                    return ctx.rawRequest.connection.remoteAddress;
                }
            }
        });

        return this.handleRequest(ctx, fn);
    }

    _onWebSocketServerConnect(isSSL, ws, upgradeReq) {
        let { _socket } = ws;
        let ctx = {
            isSSL: isSSL,
            connectRequest: this.connectRequests[_socket.remotePort + ':' + _socket.localPort] || {},
            clientToProxyWebSocket: ws,
            proxyToServerWebSocket: null
        };
        ctx.clientToProxyWebSocket.on('message', this._onWebSocketFrame.bind(this, ctx, 'message', false));
        ctx.clientToProxyWebSocket.on('ping', this._onWebSocketFrame.bind(this, ctx, 'ping', false));
        ctx.clientToProxyWebSocket.on('pong', this._onWebSocketFrame.bind(this, ctx, 'pong', false));
        ctx.clientToProxyWebSocket.on('error', this._onWebSocketError.bind(this, ctx));
        ctx.clientToProxyWebSocket.on('close', this._onWebSocketClose.bind(this, ctx, false));

        let remoteSocket = ctx.clientToProxyWebSocket._socket;
        remoteSocket.pause();

        let url;
        if (upgradeReq.url == '' || /^\//.test(upgradeReq.url)) {
            let hostPort = Vanessa.parseHostAndPort(upgradeReq);
            url = (ctx.isSSL ? 'wss' : 'ws') + '://' + hostPort.host + (hostPort.port ? ':' + hostPort.port : '') + upgradeReq.url;
        } else {
            url = upgradeReq.url;
        }
        let ptosHeaders = {};
        let ctopHeaders = upgradeReq.headers;
        for (let key in ctopHeaders) {
            if (key.indexOf('sec-websocket') !== 0) {
                ptosHeaders[key] = ctopHeaders[key];
            }
        }
        ctx.proxyToServerWebSocket = new WebSocket(url, { headers: ptosHeaders });
        ctx.proxyToServerWebSocket.on('message', this._onWebSocketFrame.bind(this, ctx, 'message', true));
        ctx.proxyToServerWebSocket.on('ping', this._onWebSocketFrame.bind(this, ctx, 'ping', true));
        ctx.proxyToServerWebSocket.on('pong', this._onWebSocketFrame.bind(this, ctx, 'pong', true));
        ctx.proxyToServerWebSocket.on('error', this._onWebSocketError.bind(this, ctx));
        ctx.proxyToServerWebSocket.on('close', this._onWebSocketClose.bind(this, ctx, true));
        ctx.proxyToServerWebSocket.on('open', () => {
            if (ctx.clientToProxyWebSocket.readyState === WebSocket.OPEN) {
                remoteSocket.resume();
            }
        });
    }

    _onWebSocketFrame(ctx, type, fromServer, data, flags) {
        let destWebSocket = fromServer ? ctx.clientToProxyWebSocket : ctx.proxyToServerWebSocket;
        if (destWebSocket.readyState === WebSocket.OPEN) {
            switch (type) {
                case 'message':
                    destWebSocket.send(data, flags);
                    break;
                case 'ping':
                    destWebSocket.ping(data, false);
                    break;
                case 'pong':
                    destWebSocket.pong(data, false);
                    break;
            }
        } else {
            this._onWebSocketError(ctx);
        }
    }

    _onWebSocketClose(ctx, closedByServer, code, message) {
        if (!ctx.closedByServer && !ctx.closedByClient) {
            ctx.closedByServer = closedByServer;
            ctx.closedByClient = !closedByServer;

            if (code >= 1004 && code <= 1006) code = 1001;
            
            if (ctx.clientToProxyWebSocket.readyState !== ctx.proxyToServerWebSocket.readyState) {
                if (ctx.clientToProxyWebSocket.readyState === WebSocket.CLOSED && ctx.proxyToServerWebSocket.readyState === WebSocket.OPEN) {
                    ctx.proxyToServerWebSocket.close(code, message);
                } else if (ctx.proxyToServerWebSocket.readyState === WebSocket.CLOSED && ctx.clientToProxyWebSocket.readyState === WebSocket.OPEN) {
                    ctx.clientToProxyWebSocket.close(code, message);
                }
            }
        }
    }

    _onWebSocketError(ctx) {
        if (ctx.proxyToServerWebSocket && ctx.clientToProxyWebSocket.readyState !== ctx.proxyToServerWebSocket.readyState) {
            if (ctx.clientToProxyWebSocket.readyState === WebSocket.CLOSED && ctx.proxyToServerWebSocket.readyState === WebSocket.OPEN) {
                ctx.proxyToServerWebSocket.close();
            } else if (ctx.proxyToServerWebSocket.readyState === WebSocket.CLOSED && ctx.clientToProxyWebSocket.readyState === WebSocket.OPEN) {
                ctx.clientToProxyWebSocket.close();
            }
        }
    }

    static parseHostAndPort(req, defaultPort) {
        let host = req.headers.host;
        if (!host) {
            return null;
        }
        let hostPort = Vanessa.parseHost(host, defaultPort);

        // this handles paths which include the full url. This could happen if it's a proxy
        let m = req.url.match(/^http:\/\/([^\/]*)\/?(.*)$/);
        if (m) {
            let parsedUrl = url.parse(req.url);
            hostPort.host = parsedUrl.hostname;
            hostPort.port = parsedUrl.port;
            req.url = parsedUrl.path;
        }

        return hostPort;
    }

    static parseHost(hostString, defaultPort) {
        let m = hostString.match(/^http:\/\/(.*)/);
        if (m) {
            let parsedUrl = url.parse(hostString);
            return {
                host: parsedUrl.hostname,
                port: parsedUrl.port
            };
        }

        let hostPort = hostString.split(':');
        let host = hostPort[0];
        let port = hostPort.length === 2 ? +hostPort[1] : defaultPort;

        return {
            host: host,
            port: port
        };
    }
}