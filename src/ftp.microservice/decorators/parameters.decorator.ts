import { SESSION_USER_PARAM_METADATA, FILEPATH_PARAM_METADATA } from "./constants";

function _createParameterDecorator(symbol: string | symbol): ParameterDecorator {
    return (target, method_name, index) => {
        const same_param_positions: number[] = Reflect
            .getMetadata(symbol, target, method_name)
            || [];
        same_param_positions.push(index);
        Reflect.defineMetadata(symbol, same_param_positions, target, method_name);
    };
}

export function SessionUser(): ParameterDecorator {
    return _createParameterDecorator(SESSION_USER_PARAM_METADATA);
}

export function filepath() {
    return _createParameterDecorator(FILEPATH_PARAM_METADATA);
}