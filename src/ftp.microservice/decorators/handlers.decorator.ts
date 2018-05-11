import { MessagePattern } from "@nestjs/microservices";
import { isFunction } from "lodash";
import { Observable } from "rxjs";

import { Channels } from "../channel";
import { EndpointHandler } from "../interfaces";
import { SESSION_USER_PARAM_METADATA, USERCHECK_HANDLER_PATTERN, DIRECTORY_LIST_HANDLER_PATTERN, FILE_DESC_HANDLER_PATTERN } from "./constants";

function _transformToObservable<T = any>(resultOrDeffered: any): Observable<T> {
    if (resultOrDeffered instanceof Promise) {
        return Observable.fromPromise(resultOrDeffered);
    } else if (!(resultOrDeffered && isFunction(resultOrDeffered.subscribe))) {
        return Observable.of(resultOrDeffered);
    }
    return resultOrDeffered;
}

function _rewriteParamsFunctionProxy(instance: Object, method_name: string, descriptor: PropertyDescriptor)
    : EndpointHandler {
    const method = descriptor.value as Function;
    return function proxy_function(data) {
        const _channel = data.channel;
        const args: any[] = [];
        if (Channels.isSessionChannel(_channel)) {
            (<number[]>(Reflect.getMetadata(SESSION_USER_PARAM_METADATA,
                instance, method_name) || []))
                .forEach(pos => {
                    args[pos] = _channel.username;
                });
        }
        return Promise.resolve(_transformToObservable(method.apply(instance, args)));
    };
}

export function UsernameCheckHandler(): MethodDecorator {
    return (target, key: string, descriptor: PropertyDescriptor) => {
        descriptor.value = _rewriteParamsFunctionProxy(target, key, descriptor);
        MessagePattern(USERCHECK_HANDLER_PATTERN)(target, key, descriptor);
        return descriptor;
    };
}

export function DirectoryListHandler(): MethodDecorator {
    return (target, key: string, descriptor: PropertyDescriptor) => {
        descriptor.value = _rewriteParamsFunctionProxy(target, key, descriptor);
        MessagePattern(DIRECTORY_LIST_HANDLER_PATTERN)(target, key, descriptor);
        return descriptor;
    };
}

export function FileDescHandler(): MethodDecorator {
    return (target, key: string, descriptor: PropertyDescriptor) => {
        descriptor.value = _rewriteParamsFunctionProxy(target, key, descriptor);
        MessagePattern(FILE_DESC_HANDLER_PATTERN)(target, key, descriptor);
        return descriptor;
    };
}