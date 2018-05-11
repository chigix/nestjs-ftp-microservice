import * as _ from "lodash";
import { getLogger } from "log4js";
import * as Path from "path";

import { Channels, FTPChannel, SessionChannel } from "./channel";
import { ServerContext, EndpointHandler, PasswordCheckFunction, File as FileEntry } from "./interfaces";
import { pathEscape, promiseSocketEnd, promiseSocketWrite } from "./helpers";
import { USERCHECK_HANDLER_PATTERN, DIRECTORY_LIST_HANDLER_PATTERN, FILE_DESC_HANDLER_PATTERN } from "./decorators/constants";
import { Observable } from "rxjs";
import * as Moment from "moment";

const LOG = getLogger("ftp.microservice/handlers.ts");

namespace INNER_EVENTS {
    export const CHECK_PASSWORD = Symbol();
    export const CHECK_PASSWORD_PASSED = Symbol();
    export const CHECK_PASSWORD_FAILED = Symbol();
}

export type HandlerFunction = (ctx: { serverContext: ServerContext, channel: FTPChannel },
    arg: string,
    handlerProvider: { [pattern: string]: EndpointHandler }
) => Promise<{ serverContext: ServerContext, channel: FTPChannel }>;

export type SessionHandlerFunction = (ctx: { serverContext: ServerContext, channel: SessionChannel },
    arg: string,
    handlerProvider: { [pattern: string]: EndpointHandler }
) => Promise<{ serverContext: ServerContext, channel: FTPChannel }>;

export class InitHandlersStatic {
    [key: string]: HandlerFunction;
    public _command_NOOP: HandlerFunction = async (ctx) => {
        await ctx.channel.respond("200 OK");
        return ctx;
    };
    public _command_QUIT: HandlerFunction = async (ctx) => {
        await ctx.channel.respond("221 Goodbye");
        ctx.channel.close();
        return ctx;
    };
    public _command_USER: HandlerFunction = (ctx, username, handlers) => {
        if (ctx.serverContext.isTlsOnly && !Channels.isSecuredChannel(ctx.channel)) {
            return ctx.channel.respond(
                "530 This server does not permit login over " +
                "a non-secure connection; " +
                "connect using FTP-SSL with explicit AUTH TLS")
                .then(() => ctx);
        }
        if (!handlers || !handlers[`"${USERCHECK_HANDLER_PATTERN}"`]) {
            return ctx.channel.respond("530 Not logged in.").then(() => ctx);
        }
        const new_ctx: (typeof ctx) = {
            serverContext: ctx.serverContext,
            channel: Channels.createSessionChannel(ctx.channel, username)
        };
        return handlers[`"${USERCHECK_HANDLER_PATTERN}"`](
            { channel: new_ctx.channel, currentCommandName: "USER" }
        ).then((observable) => {
            return observable.first().toPromise();
        }).then((auth_fun: PasswordCheckFunction) => {
            if (!auth_fun) {
                return new_ctx.channel.respond("530 Not logged in.");
            }
            new_ctx.channel.on(INNER_EVENTS.CHECK_PASSWORD, (password: string) => {
                new_ctx.channel.removeAllListeners(INNER_EVENTS.CHECK_PASSWORD);
                auth_fun(password,
                    () => new_ctx.channel.emit(INNER_EVENTS.CHECK_PASSWORD_PASSED),
                    () => new_ctx.channel.emit(INNER_EVENTS.CHECK_PASSWORD_FAILED));
            });
            return new_ctx.channel.respond("331 User name okay, need password.");
        }).then(() => {
            return new_ctx;
        });
    };
    public _command_AUTH: HandlerFunction = async (ctx, mechanism) => {
        mechanism = mechanism.toUpperCase();
        if (!ctx.serverContext.tlsOptions || mechanism !== "TLS") {
            await ctx.channel.respond("502 Command not implemented");
            return ctx;
        }
        await ctx.channel.respond("234 Honored");
        const tls_channel = await Channels.createTLSChannel(ctx.channel);
        return {
            serverContext: ctx.serverContext,
            channel: tls_channel
        };
    };
    /**
     * Find out the type of operating system
     * at the server.
     *
     * @type {HandlerFunction}
     * @memberof InitHandlersStatic
     */
    public _command_SYST: HandlerFunction = async (ctx) => {
        await ctx.channel.respond("215 UNIX Type: I");
        return ctx;
    };
    public _command_FEAT: HandlerFunction = (ctx) => {
        return ctx.channel.respond("211-Features\r\n"
            + " SIZE\r\n"
            + " UTF8\r\n"
            + " MDTM\r\n"
            + (ctx.serverContext.tlsOptions ? "" :
                " AUTH TLS\r\n" +
                " PBSZ\r\n" +
                " UTF8\r\n" +
                " PROT\r\n"
            )
            + "211 end")
            .then(() => ctx);
    };
    public _command_PBSZ: HandlerFunction = (ctx, size_received) => {
        if (!ctx.serverContext.tlsOptions) {
            return ctx.channel.respond("202 Not supported")
                .then(() => ctx);
        }
        if (!Channels.isSecuredChannel(ctx.channel)) {
            return ctx.channel.respond("503 Secure connection not established")
                .then(() => ctx);
        }
        ctx.channel.isPBSZReceived = true;
        if (parseInt(size_received, 10) === 0) {
            return ctx.channel.respond("200 OK")
                .then(() => ctx);
        }
        // RFC 2228 specifies that a 200 reply must be sent specifying a more
        // satisfactory PBSZ size (0 in our case, since we're using TLS).
        // Doubt that this will do any good if the client was already confused
        // enough to send a non-zero value, but ok...
        return ctx.channel.respond("200 buffer too big, PBSZ=0")
            .then(() => ctx);
    };
    /**
     * Return the Data Channel Protection Level supported
     * by this microservice.
     */
    public _command_PROT: HandlerFunction = (ctx, level) => {
        if (!ctx.serverContext.tlsOptions) {
            return ctx.channel.respond("202 Not supported")
                .then(() => ctx);
        }
        if (!ctx.channel.isPBSZReceived) {
            return ctx.channel.respond("503 No PBSZ command received")
                .then(() => ctx);
        }
        if (_.includes(["S", "E", "C"], level)) {
            return ctx.channel.respond("536 Not supported")
                .then(() => ctx);
        }
        if (level === "P") {
            return ctx.channel.respond("200 OK")
                .then(() => ctx);
        }
        return ctx.channel.respond("504 Not recognized")
            .then(() => ctx);
    };
    /**
     * Provide additional information for extended features supported
     * by this microservice.
     *
     * Via specification, `OPTS` command is required if `FEAT` command
     * is also implemented.
     */
    public _command_OPTS: HandlerFunction = (ctx, behavior) => {
        if (behavior.toUpperCase() === "UTF8 ON") {
            return ctx.channel.respond("200 OK")
                .then(() => ctx);
        }
        return ctx.channel.respond("451 Not supported")
            .then(() => ctx);
    };
    /**
     * https://tools.ietf.org/html/rfc959#page-28
     */
    public _command_TYPE: HandlerFunction = (ctx, type_code) => {
        if (_.includes(["I", "A"], type_code)) {
            return ctx.channel.respond("200 OK").then(() => ctx);
        }
        return ctx.channel.respond("202 Not supported").then(() => ctx);
    };
}
export class SessionHandlersStatic {
    [key: string]: SessionHandlerFunction;
    public _command_PASS: SessionHandlerFunction = (ctx, password) => {
        if (ctx.channel.previousCommand !== "USER") {
            return ctx.channel.respond("503 Bad sequence of commands.")
                .then(() => ctx);
        }
        const ret_promise = new Promise((resolve) => {
            ctx.channel.on(INNER_EVENTS.CHECK_PASSWORD_PASSED, () => {
                ctx.channel.removeAllListeners(INNER_EVENTS.CHECK_PASSWORD_FAILED);
                ctx.channel.removeAllListeners(INNER_EVENTS.CHECK_PASSWORD_PASSED);
                Channels.setSessionChannelAuthorized(ctx.channel);
                // Error when root path not accessible should be also supported:
                // ctx.channel.respond("421 Service not available, closing control connection.");
                LOG.info("LOGGED IN SUCCEEDED");
                ctx.channel.respond("230 User logged in, proceed.").then(() => {
                    resolve(ctx);
                });
            });
            ctx.channel.on(INNER_EVENTS.CHECK_PASSWORD_FAILED, () => {
                ctx.channel.removeAllListeners(INNER_EVENTS.CHECK_PASSWORD_FAILED);
                ctx.channel.removeAllListeners(INNER_EVENTS.CHECK_PASSWORD_PASSED);
                LOG.info("LOGGED IN FAILED");
                ctx.channel.respond("530 Not logged in.").then(() => {
                    resolve(ctx);
                });
            });
        }) as Promise<typeof ctx>;
        ctx.channel.emit(INNER_EVENTS.CHECK_PASSWORD, password);
        return ret_promise;
    };
    public _command_PWD: SessionHandlerFunction = (ctx, unexpected_argstring) => {
        if (unexpected_argstring === "") {
            return ctx.channel
                .respond('257 "' + pathEscape(ctx.channel.currentWorkingDir) + '" is current directory')
                .then(() => ctx);
        }
        return ctx.channel
            .respond("501 Syntax error in parameters or arguments.")
            .then(() => ctx);
    };
    /**
     * Responds a host and port address, this server is listening on,
     * to wait for a connection from FTP client.
     */
    public _command_PASV: SessionHandlerFunction = async (ctx) => {
        const port = await ctx.serverContext.passiveServersManager
            .newPasvDTPReg(ctx.channel);
        await ctx.channel.respond("227 Entering Passive Mode ("
            + ctx.serverContext.internetHostAddress.split(".").join(",")
            + "," + ((port / 256) | 0) + ","
            + (port % 256) + ")");
        return ctx;
    };

    public _command_EPSV: SessionHandlerFunction = async (ctx) => {
        await ctx.channel.respond("202 Not supported");
        return ctx;
    }

    /**
     * The `pathname` parameter should be treated as resource's
     * absolute path, which is actually previously generated in this
     * session and has been responded to this session's client.
     */
    public _command_CWD: SessionHandlerFunction = async (ctx, pathname) => {
        // ctx.channel.respond("550 Directory not found.");
        // ctx.channel.respond("550 Not a directory");
        await ctx.channel.respond("250 CWD successful. \""
            + pathEscape(pathname)
            + "\" is current directory");
        return ctx;
    }

    /**
     * Print the file modification time??
     *
     * http://www.serv-u.com/kb/1487/modification-time-mdtm
     */
    public _command_MDTM: SessionHandlerFunction = async (ctx, pathname, handlers) => {
        const handler = handlers[`"${FILE_DESC_HANDLER_PATTERN}"`];
        await handlers[`"${FILE_DESC_HANDLER_PATTERN}"`](
            { channel: ctx.channel, currentCommandName: "MDTM" }
        ).then((observable: Observable<FileEntry>) => observable.first().toPromise())
            .then((file) => {
                return ctx.channel.respond("213 " + Moment(file.updatedAt).format("YYYYMMDDHHmmss"));
            }).catch(() => {
                return ctx.channel.respond("550 File unavailable");
            });
        return ctx;
    };

    /**
     * Change working directory to parent directory.
     */
    public _command_CDUP: SessionHandlerFunction = async (ctx) => {
        const parent_path = Path.dirname(ctx.channel.currentWorkingDir);
        ctx.channel.currentWorkingDir = parent_path;
        await ctx.channel.respond("250 Directory changed to \""
            + pathEscape(parent_path) + "\"");
        return ctx;
    };

    /**
     * Creates a directory specified in the pathname (if the pathname
     * is absolute), or as a subdirectory of the current working directory
     * (if the pathname is relative).
     */
    public _command_MKD: SessionHandlerFunction = async (ctx, pathname) => {
        const directory = Path.join(ctx.channel.currentWorkingDir, pathname);
        LOG.info("Create DIR: " + directory);
        // ctx.channel.respond("257 \"" + pathEscape(directory) + "\" directory created");
        await ctx.channel.respond("550 \"" + pathEscape(directory) + "\" directory NOT created");
        return ctx;
    };

    /**
     * Responds a status, of the operation in progress or general server
     * information , in the form of a reply.
     */
    public _command_STAT: SessionHandlerFunction = async (ctx) => {
        await ctx.channel.respond("502 Not Supported");
        return ctx;
    };
}

export class DtpHandlersStatic {
    [key: string]: SessionHandlerFunction;
    /**
     * Causes a list to be sent from the server to the passive DTP
     * occupied by the channel.
     */
    public _command_LIST: SessionHandlerFunction = async (ctx, pathname, handlers) => {
        const observable: Observable<FileEntry> = await handlers[`"${DIRECTORY_LIST_HANDLER_PATTERN}"`](
            { channel: ctx.channel, currentCommandName: "LIST" }
        );
        const dtp_socket = await ctx.serverContext
            .passiveServersManager.getPasvDTPSocket(ctx.channel);
        await ctx.channel.respond("150 Here comes the directory listing");
        observable.subscribe({
            next: async (file) => {
                const line = ""
                    + "-rw-rw-rw- 1 s3username groupname "
                    + `${_.padStart(file.length + "", 12, " ")} `
                    + `${_.padStart(Moment(file.updatedAt).format("MMM DD HH:mm"), 12, " ")} `
                    + file.filename
                    + "\r\n";
                await promiseSocketWrite(dtp_socket, line, "utf8");
            },
            complete: async () => {
                // help make sure close_notify could be sent
                // if it is TLS Socket currently.
                await promiseSocketEnd(dtp_socket);
                await ctx.channel.respond("226 Transfer OK");
            }
        });
        return ctx;
    };

    /**
     * Send a list of files to the client over a passive DTP
     * connection established previously.
     *
     * http://www.serv-u.com/kb/1463/name-list-nlst
     */
    public _command_NLST: SessionHandlerFunction = async (ctx) => {
        await ctx.channel.respond("502 Not Supported");
        return ctx;
    };

    /**
     * Makes the server-DTP to accept the data transferred via the
     * passive DTP connection and to store the data as a file to the
     * specified pathname at the server side.
     */
    public _command_STOR: SessionHandlerFunction = async (ctx, pathname) => {
        ctx.serverContext.passiveServersManager
            .getPasvDTPSocket(ctx.channel).then((socket) => {
                let retrieved_bytes_count = 0;
                socket.on("data", (buf) => {
                    LOG.trace(buf.toString("utf-8"));
                    retrieved_bytes_count += buf.byteLength;
                });
                socket.on("close", () => {
                    LOG.debug("Retrieved Bytes Length: " + retrieved_bytes_count);
                    ctx.channel.respond("226 Closing data connection");
                });
            });
        await ctx.channel.respond("150 Ok to send data");
        return ctx;
    };

    /**
     * Transfers a copy of the file, specified in the pathname, to the
     * DTP at the other end of the data connection. The status and
     * contents of the file at the server site will be unaffected.
     */
    public _command_RETR: SessionHandlerFunction = async (ctx, pathname) => {
        return ctx;
    };

    /**
     * Accepts the data transferred via the DTP connection and to
     * append the data into a file as the pathname specified at
     * the server side.
     */
    public _command_APPE: HandlerFunction = async (ctx, pathname) => {
        await ctx.channel.respond("502 APPE not implemented.");
        // await ctx.channel.respond("150 Ok to send data");
        return ctx;
    };
}

export const InitHandlers = new InitHandlersStatic();
export const SessionHandlers = new SessionHandlersStatic();
export const DtpHandlers = new DtpHandlersStatic();