import { EventEmitter } from "events";
import { getLogger } from "log4js";
import * as Net from "net";

import { Channels, SessionChannel } from "./channel";
import { startTlsServer, TlsOptions } from "./tls.wrapper";
import { Observable } from "rxjs";

const LOG = getLogger(`ftp.microservice/passive-server-manager.ts`);

namespace INNER_EVENTS {
    /**
     * No argument.
     */
    export const SERVER_RELEASED = Symbol();
}

interface PasvServerOccupyContext {
    server: Net.Server;
    occupiedBy: {
        channel: SessionChannelExtension,
        resolveSocket: (socket: Net.Socket) => void,
    };
    readonly port: number;
}

interface SessionChannelExtension extends SessionChannel {
    _pasvDataSocketObservable: Observable<Net.Socket>;
    isPasvPortConfigured: boolean;
}

export class PassiveServersManager {
    private readonly eventsPublisher = new EventEmitter();
    private readonly sleepingServers: (PasvServerOccupyContext)[] = [];
    private readonly waitingChannelCalls: (
        (server: PasvServerOccupyContext)
            => SessionChannelExtension)[] = [];
    private readonly tlsOptions: TlsOptions;
    constructor(ports: number[], options: { tlsOptions: TlsOptions }) {
        ports.forEach(port => {
            this.sleepingServers.push({ port: port, server: undefined, occupiedBy: undefined });
        });
        this.tlsOptions = options.tlsOptions;
        this.eventsPublisher.on(INNER_EVENTS.SERVER_RELEASED, (bind_ctx: PasvServerOccupyContext) => {
            if (bind_ctx.occupiedBy) {
                return;
            }
            const channel_call = this.waitingChannelCalls.shift();
            if (channel_call) {
                const _channel = bind_ctx.occupiedBy.channel;
                bind_ctx.occupiedBy = {
                    channel: channel_call(bind_ctx),
                    resolveSocket: undefined
                };
                _channel._pasvDataSocketObservable = Observable
                    .fromPromise(new Promise<Net.Socket>((resolve) => {
                        bind_ctx.occupiedBy.resolveSocket = resolve;
                    }));
                _channel.isPasvPortConfigured = true;
            }
            if (bind_ctx.occupiedBy && bind_ctx.occupiedBy.channel.isOpen) {
                return;
            }
            bind_ctx.occupiedBy = undefined;
            this.sleepingServers.push(bind_ctx);
        });
    }
    /**
     * Return the port of occupied server in promise.
     */
    public newPasvDTPReg(channel: SessionChannel): Promise<number> {
        const _channel = channel as SessionChannelExtension;
        _channel._pasvDataSocketObservable = undefined;
        _channel.isPasvPortConfigured = false;
        const self = this;
        function occupyOneServer() {
            let binding = self.sleepingServers[0];
            while (binding = self.sleepingServers.shift()) {
                if (!binding.server) {
                    binding.server = startPasvTransferServer(
                        () => {
                            return {
                                channel: binding.occupiedBy.channel,
                                resolveSocket: binding.occupiedBy.resolveSocket,
                                TLSOptions: self.tlsOptions,
                                port: binding.port
                            };
                        }, function onConnect() {
                            binding.occupiedBy = undefined;
                            self.eventsPublisher.emit(INNER_EVENTS.SERVER_RELEASED, binding);
                        }, function onClose() { }
                    ).listen(binding.port);
                }
                if (!binding.occupiedBy) {
                    binding.occupiedBy = {
                        channel: _channel,
                        resolveSocket: undefined
                    };
                    _channel._pasvDataSocketObservable = Observable
                        .fromPromise(new Promise<Net.Socket>((resolve) => {
                            binding.occupiedBy.resolveSocket = resolve;
                        }));
                    _channel.isPasvPortConfigured = true;
                    return binding;
                }
            }
            return undefined;
        }
        const first_try = occupyOneServer();
        if (first_try) {
            return Promise.resolve(first_try.port);
        }
        return new Promise((resolve, reject) => {
            this.waitingChannelCalls.push((server) => {
                if (!channel.isOpen) {
                    reject("Channel Closed.");
                    return undefined;
                }
                resolve(server.port);
                return _channel;
            });
        });
    }

    public getPasvDTPSocket(channel: SessionChannel) {
        const _channel = channel as SessionChannelExtension;
        return _channel._pasvDataSocketObservable.first().toPromise().then((socket) => {
            if (!socket || !socket.writable) {
                throw "Unexpected!!!The socket is not writable. Inspect [observable.first()].";
            }
            return socket;
        });
    }
}

function startPasvTransferServer(
    snapshot: () => {
        channel: SessionChannelExtension,
        resolveSocket: (socket: Net.Socket) => void,
        TLSOptions: TlsOptions,
        port: number
    },
    onConnect: () => void,
    onClose: () => void) {
    return Net.createServer((socket) => {
        // The order of snapshot and onConnect must be exact.
        const ctx_snapshot = snapshot();
        if (!ctx_snapshot.channel) {
            socket.end();
            socket.destroy();
            return;
        }
        onConnect();
        socket.on("close", () => {
            LOG.trace("Passive data listener closed");
            onClose();
            ctx_snapshot.channel.isPasvPortConfigured = false;
        });
        socket.on("end", () => onClose);
        function respondOnError(socket: Net.Socket) {
            socket.on("error", (e) => {
                LOG.error(e.message, e);
                ctx_snapshot.channel.respond("421 Server was unable to open passive connection listener");
            });
        }
        if (Channels.isSecuredChannel(ctx_snapshot.channel)) {
            startTlsServer(socket, ctx_snapshot.TLSOptions).then((socket) => {
                respondOnError(socket);
                ctx_snapshot.resolveSocket(socket);
            });
        } else {
            respondOnError(socket);
            ctx_snapshot.resolveSocket(socket);
        }
        LOG.trace(`Passive data connection beginning to listen on port: [${ctx_snapshot.port}]`);
    });
}