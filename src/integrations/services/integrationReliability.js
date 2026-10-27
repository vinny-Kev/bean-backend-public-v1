const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export class IntegrationProcessingError extends Error {
    constructor(code, summary, classification) {
        super(summary);
        this.name = 'IntegrationProcessingError';
        this.code = code;
        this.classification = classification;
    }
}

export const classifyIntegrationFailure = (error) => {
    if (error instanceof IntegrationProcessingError) {
        return { code: error.code, summary: error.message, classification: error.classification };
    }
    if (['40001', '40P01', '53300', '53400', '57P01', '57P02', '57P03'].includes(error?.code)
        || String(error?.code ?? '').startsWith('08')
        || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(error?.code)) {
        return { code: 'DATABASE_TRANSIENT', summary: 'A temporary database failure interrupted processing.', classification: 'transient' };
    }
    if (error?.code === '23505') {
        return { code: 'BUSINESS_CONFLICT', summary: 'A conflicting business record already exists.', classification: 'action_required' };
    }
    return { code: 'PROCESSING_ERROR', summary: 'Processing failed and requires investigation.', classification: 'action_required' };
};

export const nextIntegrationRetryAt = ({ attemptNumber, maxAttempts, delays = RETRY_DELAYS_MS, now = Date.now(), random = Math.random }) => {
    if (attemptNumber >= maxAttempts) return null;
    const delay = delays[Math.min(attemptNumber - 1, delays.length - 1)];
    const jitter = 0.8 + (random() * 0.4);
    return new Date(now + Math.round(delay * jitter));
};
