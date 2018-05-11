import * as Net from "net";

export function pathEscape(text: string) {
    // Rules for quoting: RFC 959 -> Appendix II -> Directory Commands
    // (http://www.w3.org/Protocols/rfc959/A2_DirectoryCommands.html)
    // -> Reply Codes -> search for "embedded double-quotes"
    text = text.replace(/"/g, '""');
    text = text.replace("\\", "/");
    return text;
}

export function promiseSocketWrite(socket: Net.Socket,
    data: string, encoding = "utf8")
    : Promise<void> {
    return new Promise((resolve) => {
        socket.write(data, encoding, resolve);
    });
}

export function promiseSocketEnd(socket: Net.Socket)
    : Promise<void> {
    return new Promise((resolve) => {
        socket.end(resolve);
    });
}