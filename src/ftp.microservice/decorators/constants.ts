const date = new Date().toISOString();

export const SESSION_USER_PARAM_METADATA = Symbol("__username__");
export const FILEPATH_PARAM_METADATA = Symbol("__FILEPATH__");

export const USERCHECK_HANDLER_PATTERN = `${date}__usercheck_handler__`;
export const DIRECTORY_LIST_HANDLER_PATTERN = `${date}__directory_list_handler__`;
export const FILE_DESC_HANDLER_PATTERN = `${date}__file_desc_handler__`;