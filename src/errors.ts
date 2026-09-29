export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const unavailable = () =>
  new GatewayError(
    503,
    'SERVICE_UNAVAILABLE',
    'Service temporarily unavailable. Please retry.',
  );
export const unauthorized = () =>
  new GatewayError(401, 'UNAUTHENTICATED', 'Please sign in again.');
export const forbidden = () =>
  new GatewayError(
    403,
    'FORBIDDEN',
    'You do not have permission for this request.',
  );
