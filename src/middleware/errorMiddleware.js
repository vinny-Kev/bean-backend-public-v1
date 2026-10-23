import { randomUUID } from 'node:crypto';

export const requestContext = (req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    return next();
};

export const notFoundHandler = (req, res) => {
    return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId: req.requestId },
    });
};

export const errorHandler = (error, req, res, _next) => {
    const status = error.status === 413 ? 413
        : error.status === 400 ? 400
            : error.status === 403 ? 403
                : 500;
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE'
        : status === 400 ? 'BAD_REQUEST'
            : status === 403 ? 'ORIGIN_DENIED'
                : 'INTERNAL_SERVER_ERROR';
    const message = status === 413 ? 'Request payload is too large.'
        : status === 400 ? 'Request could not be parsed.'
            : status === 403 ? 'Request origin is not allowed.'
                : 'An unexpected error occurred.';

    // Do not log the error message, request body, SQL, headers, or environment values.
    console.error(JSON.stringify({
        level: 'error',
        event: 'request_error',
        requestId: req.requestId,
        status,
        code,
        errorName: error.name,
        ...(error.code && { databaseCode: error.code }),
        ...(error.table && { databaseTable: error.table }),
        ...(error.column && { databaseColumn: error.column }),
        ...(error.constraint && { databaseConstraint: error.constraint }),
    }));

    if (res.headersSent) return res.end();
    return res.status(status).json({
        error: { code, message, requestId: req.requestId },
    });
};
