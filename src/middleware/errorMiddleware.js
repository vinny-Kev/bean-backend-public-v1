import { randomUUID } from 'node:crypto';
import { recordIntegrationDiagnostic } from '../integrations/services/integrationDiagnostics.js';

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

export const errorHandler = async (error, req, res, _next) => {
    const status = error.status === 413 ? 413
        : error.status === 400 ? 400
            : error.status === 403 ? 403
                : error.status === 422 ? 422
                : 500;
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE'
        : status === 400 ? 'BAD_REQUEST'
            : status === 403 ? 'ORIGIN_DENIED'
                : status === 422 ? 'UNPROCESSABLE_ENTITY'
                : 'INTERNAL_SERVER_ERROR';
    const message = status === 413 ? 'Request payload is too large.'
        : status === 400 ? 'Request could not be parsed.'
            : status === 403 ? 'Request origin is not allowed.'
                : status === 422 ? 'The request could not be processed.'
                : 'An unexpected error occurred.';

    if (req.integration && ['entity.parse.failed', 'entity.too.large'].includes(error.type)) {
        await recordIntegrationDiagnostic({ req, integration: req.integration, outcome: 'invalid',
            errorCode: error.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
            errorSummary: error.type === 'entity.too.large' ? 'Request body exceeds the allowed size.' : 'Request body is not valid JSON.', httpStatus: status });
    }

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
