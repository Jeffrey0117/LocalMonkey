'use strict';

class DuplicateIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DuplicateIdError';
    this.code = 'DUPLICATE_ID';
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
  }
}

module.exports = { DuplicateIdError, NotFoundError };
