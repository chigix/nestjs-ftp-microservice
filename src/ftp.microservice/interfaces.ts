import { PassiveServersManager } from "./passive-server-manager";
import { TlsOptions } from "./tls.wrapper";
import { FTPChannel } from "./channel";
import { Observable } from "rxjs";

export interface ServerContext {
    readonly internetHostAddress: string;
    readonly isTlsOnly: boolean;
    readonly tlsOptions: TlsOptions;
    readonly passiveServersManager: PassiveServersManager;
}

export interface EndpointHandler {
    (data: {
        channel: FTPChannel,
        currentCommandName: string
    }): Promise<Observable<any>>;
}

export type PasswordCheckFunction = (
    password: string,
    success: () => {},
    failed: () => {}) => void;

export interface File {
    isDirectory: boolean;
    filename: string;
    parentPath: string;
    length: number;
    createdAt: Date;
    updatedAt: Date;
}