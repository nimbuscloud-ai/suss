import type { LibraryException } from "@suss/adapter-ruby";

/**
 * A copy of Rack's `Rack::Utils::SYMBOL_TO_STATUS_CODE`, which Rails uses
 * to turn a status symbol into a number.
 *
 * Rack has renamed four of these codes across releases, and an app can
 * pin any of them, so every spelling of each is listed with its number.
 */
export const RACK_STATUS_CODE_NAMES: Record<string, number> = {
  continue: 100,
  switching_protocols: 101,
  processing: 102,
  early_hints: 103,
  ok: 200,
  created: 201,
  accepted: 202,
  non_authoritative_information: 203,
  no_content: 204,
  reset_content: 205,
  partial_content: 206,
  multi_status: 207,
  already_reported: 208,
  im_used: 226,
  multiple_choices: 300,
  moved_permanently: 301,
  found: 302,
  see_other: 303,
  not_modified: 304,
  use_proxy: 305,
  temporary_redirect: 307,
  permanent_redirect: 308,
  bad_request: 400,
  unauthorized: 401,
  payment_required: 402,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  not_acceptable: 406,
  proxy_authentication_required: 407,
  request_timeout: 408,
  conflict: 409,
  gone: 410,
  length_required: 411,
  precondition_failed: 412,
  request_entity_too_large: 413,
  payload_too_large: 413,
  content_too_large: 413,
  request_uri_too_long: 414,
  uri_too_long: 414,
  unsupported_media_type: 415,
  requested_range_not_satisfiable: 416,
  range_not_satisfiable: 416,
  expectation_failed: 417,
  misdirected_request: 421,
  unprocessable_entity: 422,
  unprocessable_content: 422,
  locked: 423,
  failed_dependency: 424,
  too_early: 425,
  upgrade_required: 426,
  precondition_required: 428,
  too_many_requests: 429,
  request_header_fields_too_large: 431,
  unavailable_for_legal_reasons: 451,
  internal_server_error: 500,
  not_implemented: 501,
  bad_gateway: 502,
  service_unavailable: 503,
  gateway_timeout: 504,
  http_version_not_supported: 505,
  variant_also_negotiates: 506,
  insufficient_storage: 507,
  loop_detected: 508,
  not_extended: 510,
  network_authentication_required: 511,
};

const STANDARD_ERROR = ["StandardError", "Exception"];
const ACTION_CONTROLLER_ERROR = [
  "ActionController::ActionControllerError",
  ...STANDARD_ERROR,
];
const ACTIVE_RECORD_ERROR = [
  "ActiveRecord::ActiveRecordError",
  ...STANDARD_ERROR,
];
const INDEX_ERROR = ["IndexError", ...STANDARD_ERROR];

/**
 * The exceptions Rails and ActiveRecord raise in a controller, with the
 * classes each one inherits from. `status` is the entry Rails, and
 * ActiveRecord's railtie, add to `rescue_responses`.
 */
export const LIBRARY_EXCEPTIONS: Record<string, LibraryException> = {
  "ActionController::ActionControllerError": { ancestors: STANDARD_ERROR },
  "ActionController::BadRequest": {
    status: 400,
    ancestors: ACTION_CONTROLLER_ERROR,
  },
  "ActionController::ParameterMissing": {
    status: 400,
    ancestors: ["KeyError", ...INDEX_ERROR],
  },
  "ActionController::UnpermittedParameters": { ancestors: INDEX_ERROR },
  "ActionController::RoutingError": {
    status: 404,
    ancestors: ACTION_CONTROLLER_ERROR,
  },
  "AbstractController::ActionNotFound": {
    status: 404,
    ancestors: STANDARD_ERROR,
  },
  "ActionController::MethodNotAllowed": {
    status: 405,
    ancestors: ACTION_CONTROLLER_ERROR,
  },
  "ActionController::NotImplemented": {
    status: 501,
    ancestors: [
      "ActionController::MethodNotAllowed",
      ...ACTION_CONTROLLER_ERROR,
    ],
  },
  "ActionController::UnknownFormat": {
    status: 406,
    ancestors: ACTION_CONTROLLER_ERROR,
  },
  "ActionController::InvalidAuthenticityToken": {
    status: 422,
    ancestors: ACTION_CONTROLLER_ERROR,
  },
  "ActiveRecord::ActiveRecordError": { ancestors: STANDARD_ERROR },
  "ActiveRecord::RecordNotFound": {
    status: 404,
    ancestors: ACTIVE_RECORD_ERROR,
  },
  "ActiveRecord::RecordInvalid": {
    status: 422,
    ancestors: ACTIVE_RECORD_ERROR,
  },
  "ActiveRecord::RecordNotSaved": {
    status: 422,
    ancestors: ACTIVE_RECORD_ERROR,
  },
  "ActiveRecord::StaleObjectError": {
    status: 409,
    ancestors: ACTIVE_RECORD_ERROR,
  },
};
