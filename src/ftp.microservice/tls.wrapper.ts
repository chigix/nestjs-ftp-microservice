import * as Net from "net";
import * as Tls from "tls";
import * as Crypto from "crypto";
import * as _ from "lodash";
import { getLogger } from "log4js";

const LOG = getLogger(`ftp.microservice/tls.wrapper.ts`);

// From Node docs for TLS module.
const RECOMMENDED_CIPHERS = "ECDHE-RSA-AES256-SHA:AES256-SHA:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM";
export function startTlsServer(socket: Net.Socket, options: TlsOptions): Promise<Tls.TLSSocket> {
    return startTLS(socket, options, true);
}
export function startTlsClient(socket: Net.Socket, options: TlsOptions): Promise<Tls.TLSSocket> {
    return startTLS(socket, options, false);
}

function startTLS(socket: Net.Socket, options: TlsOptions, isServer: boolean): Promise<Tls.TLSSocket> {
    const opts: { [index: string]: any } = _.clone(options);
    if (!(<Tls.SecureContextOptions>opts).ciphers) {
        opts.ciphers = RECOMMENDED_CIPHERS;
    }
    socket.removeAllListeners("data");
    return new Promise((resolve, reject) => {
        const secure_socket = new Tls.TLSSocket(socket, {
            secureContext: Tls.createSecureContext(opts),
            isServer: isServer
        });
        secure_socket.on("error", (e) => LOG.debug(e));
        secure_socket.on("secure", () => {
            resolve(secure_socket);
        });
    });
}

export type TlsOptions =
    (Tls.SecureContextOptions | Crypto.CredentialDetails) & { [index: string]: any };