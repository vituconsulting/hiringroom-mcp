/** Bad tool input; the message is shown to Claude as-is. */
export class InputError extends Error {
  override name = "InputError";
}

export class AuthError extends Error {
  override name = "AuthError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
  constructor(
    public path: string,
    message = "no existe el recurso solicitado en HiringRoom",
  ) {
    super(message);
  }
}

export class HrValidationError extends Error {
  override name = "HrValidationError";
  constructor(public messages: string[]) {
    super(messages.join("; "));
  }
}

export class UpstreamError extends Error {
  override name = "UpstreamError";
}
