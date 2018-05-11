import { EventEmitter } from "events";
import { getLogger } from "log4js";
import * as Net from "net";
import * as Tls from "tls";

import FTPServer from "./server";
import { startTlsServer } from "./tls.wrapper";

const LOG = getLogger(`ftp.microservice/channel.ts`);

namespace Events {
    export const CLOSED = Symbol();
}

/**
 * FTPChannel
 */
export interface FTPChannel {
    readonly isOpen: boolean;
    isPBSZReceived: boolean;
    previousCommand: string;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    emit(event: string | symbol, ...args: any[]): boolean;
    removeAllListeners(event?: string | symbol): this;
    writeText(msg: string): Promise<void>;
    respond(msg: string): Promise<void>;
    close(): void;
}

export interface SessionChannel extends FTPChannel {
    readonly username: string;
    readonly isAuthorized: boolean;
    currentWorkingDir: string;
    readonly isPasvPortConfigured: boolean;
}

export class ChannelUtilsStatic {
    /**
     * createFTPChannel
     */
    public createFTPChannel(arg: { server: FTPServer, socket: Net.Socket }): FTPChannel {
        return new DefaultFTPChannel(arg.server, arg.socket);
    }

    /**
     * createTLSChannel
     */
    public createTLSChannel(originalChannel: FTPChannel) {
        const _originalChannel = originalChannel as DefaultFTPChannel;
        const data_listeners = _originalChannel.socket.listeners("data");
        _originalChannel.socket.removeAllListeners("data");
        return startTlsServer(
            _originalChannel.socket,
            _originalChannel.server.serverContext.tlsOptions).then((tls_socket) => {
                data_listeners.forEach((fn) => {
                    tls_socket.on("data", <any>fn);
                });
                tls_socket.on("error", (err) => { LOG.error(err); });
                return new DefaultTlsFTPChannel(_originalChannel.server, tls_socket) as FTPChannel;
            });
    }

    /**
     * createSessionChannel
     */
    public createSessionChannel(ftpchannel: FTPChannel, username: string): SessionChannel {
        if (!(ftpchannel instanceof DefaultFTPChannel)) {
            throw "Unacceptable Channel object was given "
            + `to create session channel: ${typeof ftpchannel}`;
        }
        return new DefaultSessionChannel(<DefaultFTPChannel>ftpchannel, username);
    }

    /**
     * isSecuredChannel
     */
    public isSecuredChannel(channel: FTPChannel) {
        return (<DefaultFTPChannel>channel).isSecure;
    }

    /**
     * isSessionChannel
     */
    public isSessionChannel(channel: FTPChannel): channel is SessionChannel {
        return channel instanceof DefaultSessionChannel;
    }

    /**
     * setSessionChannelAuthorized
     */
    public setSessionChannelAuthorized(channel: SessionChannel) {
        const _channel = channel as DefaultSessionChannel;
        _channel.isAuthorized = true;
    }
}

class DefaultFTPChannel implements FTPChannel {
    private readonly events = new EventEmitter();
    private authInfo: { username: string, cwd: string, isAuthenticated: boolean } = undefined;
    public previousCommand: string = undefined;
    private closeChannelInvoked = false;
    /**
     * Protection Buffer Size (RFC 2228)
     *
     * @memberof FTPChannel
     */
    public isPBSZReceived = false;
    public passiveSocket: Net.Socket = undefined;

    constructor(
        public readonly server: FTPServer,
        public readonly socket: Net.Socket) {
    }

    public get isOpen() {
        if (this.closeChannelInvoked) {
            return false;
        }
        if (!this.socket.writable) {
            return false;
        }
        if (this.socket.destroyed) {
            return false;
        }
        return true;
    }

    on(event: string | symbol, listener: (...args: any[]) => void): this {
        this.events.on(event, listener);
        return this;
    }
    emit(event: string | symbol, ...args: any[]): boolean {
        return this.events.emit(event, args);
    }
    removeAllListeners(event?: string | symbol): this {
        this.events.removeAllListeners(event);
        return this;
    }
    public get isSecure() {
        return false;
    }

    public getAuthInfo() {
        return this.authInfo;
    }

    public loginAs(username: string) {
        this.authInfo = { username: username, cwd: "/", isAuthenticated: false };
    }

    /**
     * writeText
     */
    public async writeText(msg: string): Promise<void> {
        if (!this.socket.writable) {
            throw new SocketException("Connection reset by peer: socket write error.");
        }
        return new Promise<void>((resolve) => {
            LOG.trace(`>> ${msg.trim()}`);
            if (this.socket.write(msg, "utf8", resolve) === false) {
                throw new SocketException("Broken pipe.");
            }
        });
    }

    /**
     * async respond
     */
    public async respond(msg: string) {
        return this.writeText(`${msg}\r\n`);
    }

    /**
     * Requests to close this {@link FTPChannel}.
     *
     * @memberof FTPChannel
     */
    public close(): void {
        this.closeChannelInvoked = true;
        this.socket.writable && this.socket.end();
        !this.socket.destroyed && this.socket.destroy();
    }

}

class DefaultTlsFTPChannel extends DefaultFTPChannel {

    constructor(
        server: FTPServer,
        socket: Tls.TLSSocket) {
        super(server, socket);
    }

    public get isSecure() {
        return true;
    }

}

class DefaultSessionChannel implements SessionChannel {

    currentWorkingDir = "/";
    public isAuthorized = false;
    private readonly events = new EventEmitter();
    public readonly isPasvPortConfigured = false;

    constructor(
        readonly ftpChannel: DefaultFTPChannel,
        public username: string) {
    }

    public get isOpen() {
        return this.ftpChannel.isOpen;
    }

    on(event: string | symbol, listener: (...args: any[]) => void): this {
        this.events.on(event, listener);
        return this;
    }
    emit(event: string | symbol, ...args: any[]): boolean {
        return this.events.emit(event, args);
    }
    removeAllListeners(event?: string | symbol): this {
        this.events.removeAllListeners(event);
        this.ftpChannel.removeAllListeners(event);
        return this;
    }
    public get isPBSZReceived() {
        return this.ftpChannel.isPBSZReceived;
    }
    public set isPBSZReceived(v: boolean) {
        this.ftpChannel.isPBSZReceived = v;
    }

    public get previousCommand(): string {
        return this.ftpChannel.previousCommand;
    }
    public set previousCommand(v: string) {
        this.ftpChannel.previousCommand = v;
    }

    writeText(msg: string): Promise<void> {
        return this.ftpChannel.writeText(msg);
    }
    respond(msg: string): Promise<void> {
        return this.ftpChannel.respond(msg);
    }
    close(): void {
        this.emit(Events.CLOSED);
        return this.ftpChannel.close();
    }
}

class SocketException extends Error { }

export const Channels = new ChannelUtilsStatic();