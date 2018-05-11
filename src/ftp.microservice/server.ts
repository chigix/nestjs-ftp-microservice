import { CustomTransportStrategy, Server } from "@nestjs/microservices";
import * as _ from "lodash";
import * as Log4js from "log4js";
import * as Net from "net";

import { Channels } from "./channel";
import { ServerContext } from "./interfaces";
import { DtpHandlers, InitHandlers, SessionHandlers } from "./handlers";
import { PassiveServersManager } from "./passive-server-manager";
import { TlsOptions } from "./tls.wrapper";

const LOG = Log4js.getLogger(`ftp.microservice/server.ts`);

/**
 * Provide an implementation of [RFC 959 "File Transfer Protocol (FTP)"]
 * (http://tools.ietf.org/html/rfc959) as an NestJS' microservice.
 *
 * Both active and passive modes are supported.
 *
 * @export
 * @class FTPServer
 * @extends {Server}
 * @implements {CustomTransportStrategy}
 */
export default class FTPServer extends Server implements CustomTransportStrategy {

    private readonly tcpServer: Net.Server;
    public readonly serverContext: ServerContext;

    /**
     * Creates an instance of FTPServer.
     * @param {number} port port number of this serverContext
     * @param {string} host host ip address written as 127.0.0.1
     * @param {ServerOptions} [options={
     *             passivePorts: []
     *         }] Options for this serverContext's configuration.
     * @memberof FTPServer
     */
    constructor(
        private readonly port: number,
        private readonly host: string,
        options: ServerOptions = {
            passivePorts: []
        }) {
        super();
        const ctx = new ServerContextImpl();
        ctx.internetHostAddress = host;
        if (options.tlsOnly) {
            ctx.isTlsOnly = true;
        }
        if (options.tlsOptions) {
            ctx.tlsOptions = options.tlsOptions;
        }
        ctx.passiveServersManager = new PassiveServersManager(
            options.passivePorts,
            { tlsOptions: ctx.tlsOptions });
        this.serverContext = ctx;
        this.tcpServer = Net.createServer(this.bindHandler.bind(this));
    }

    listen(callback: () => void) {
        this.tcpServer.listen(this.port, callback);
    }

    close() {
        this.tcpServer.close();
    }

    /**
     * bindHandler
     */
    public bindHandler(socket: Net.Socket) {
        socket.setTimeout(0);
        socket.setNoDelay();
        let _channel = Channels.createFTPChannel({ server: this, socket: socket });
        _channel.respond("220 FTP interface for S3(-compatibles) ready");
        const onData = (buf: Buffer) => {
            if (!_channel.isOpen) {
                return;
            }
            // @TODO CRLF and length check should be done before.
            const msg = buf.toString("utf-8");
            LOG.trace(`<< ${msg.trim()}`);
            let command: string, commandArg: string;
            let parts: string[] = [];
            const index = msg.indexOf(" ");
            if (index === -1) {
                command = msg.toUpperCase().trim();
                commandArg = "";
            } else {
                parts = msg.split(" ");
                command = parts.shift().toUpperCase().trim();
                commandArg = parts.join(" ").trim();
            }
            const m = "_command_" + command;
            ((): Promise<void> => {
                if (InitHandlers[m]) {
                    return InitHandlers[m]({
                        serverContext: this.serverContext,
                        channel: _channel
                    }, commandArg, this.getHandlers())
                        .then(updated_ctx => {
                            _channel = updated_ctx.channel;
                        });
                }
                // If 'tlsOnly' option is set, all commands which require
                // user authentication will only be permitted over a secure
                // connection. See RFC4217 regarding error code.
                if (this.serverContext.isTlsOnly
                    && !Channels.isSecuredChannel(_channel)) {
                    return _channel.respond("522 Protection level not sufficient; send AUTH TLS");
                }
                if (!SessionHandlers[m] && !DtpHandlers[m]) {
                    return _channel.respond("502 " + command + " not implemented.");
                }
                if (!Channels.isSessionChannel(_channel)
                    || !(_channel.isAuthorized || command == "PASS")) {
                    return _channel.respond("530 Not logged in.");
                }
                if (SessionHandlers[m]) {
                    return SessionHandlers[m]({
                        serverContext: this.serverContext,
                        channel: _channel
                    }, commandArg, this.getHandlers()).then(_.noop);
                }
                if (!_channel.isPasvPortConfigured) {
                    return _channel.respond("425 Data connection not configured; send PASV or PORT");
                }
                return DtpHandlers[m]({
                    serverContext: this.serverContext,
                    channel: _channel
                }, commandArg, this.getHandlers()).then(_.noop);
            })().then(() => {
                _channel.previousCommand = command;
            });
        };
        socket.on("data", onData);
        socket.on("end", () => {
            LOG.debug("Client connection ended");
        });
        socket.on("error", (err) => {
            LOG.error(err.message, err);
            _channel.close();
        });
        socket.on("close", (hadError) => {
            LOG.debug("Client connection closed");
            _channel.close();
        });
    }

}

export interface ServerOptions {
    tlsOnly?: boolean;
    tlsOptions?: TlsOptions;
    passivePorts: number[];
}

class ServerContextImpl implements ServerContext {
    internetHostAddress: string;
    isTlsOnly: boolean = false;
    tlsOptions: TlsOptions = undefined;
    passiveServersManager: PassiveServersManager;
}
