'use strict';
/** Throw an HttpError anywhere in a handler; the app turns it into `{ error }` JSON. */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (message = 'Invalid request', details) => new HttpError(400, message, details);
const unauthorized = (message = 'Please sign in') => new HttpError(401, message);
const forbidden = (message = 'You do not have access to this') => new HttpError(403, message);
const notFound = (message = 'Not found') => new HttpError(404, message);
const conflict = (message = 'This already exists') => new HttpError(409, message);
const tooLarge = (message = 'Request too large') => new HttpError(413, message);
const tooMany = (message = 'Too many requests. Please wait a moment.') => new HttpError(429, message);
const unavailable = (message = 'Service unavailable') => new HttpError(503, message);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooLarge, tooMany, unavailable };
