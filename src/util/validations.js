

export const compareToPattern = (value, pattern) => {
    switch (pattern) {
        case 'alphanumeric':
            return /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(value);
        case 'email':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        case 'password':
            return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d\s])\S{8,}$/.test(value);
        case 'sku':
            return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value);
        case 'item_id':
            return /^[1-9]\d*$/.test(value);
        case 'slug':
            return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
        // Integration event envelope and payload fields.
        case 'event_id':
            return /^[A-Za-z0-9._:-]{1,255}$/.test(value);
        case 'event_type':
            return /^[a-z][a-z0-9_.-]{1,99}$/.test(value);
        case 'product_id':
            return /^[A-Za-z0-9-]{1,100}$/.test(value);
        case 'money_amount':
            return /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value);
        case 'currency_code':
            return /^[A-Z]{3}$/.test(value);
        default:
            return false;
    }

};

export const inRangeOfLength = (value, min, max) => {
    return value.length >= min && value.length <= max;
};

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Route and query IDs arrive as strings; returns a safe positive integer or null.
export const parsePositiveId = (value) => typeof value === 'string' && compareToPattern(value, 'item_id')
    && Number.isSafeInteger(Number(value)) ? Number(value) : null;

// Parses optional `from`/`to` query timestamps. With defaultDays, a missing bound
// defaults to [to - defaultDays, now]; maxDays caps the window size.
export const parseTimestampRange = (query, { defaultDays = null, maxDays = null, now = new Date() } = {}) => {
    const parsed = {};
    for (const key of ['from', 'to']) {
        if (query?.[key] === undefined) continue;
        const timestamp = typeof query[key] === 'string' ? Date.parse(query[key]) : Number.NaN;
        if (!Number.isFinite(timestamp)) return { error: `${key} must be a valid timestamp.` };
        parsed[key] = new Date(timestamp);
    }
    let { from = null, to = null } = parsed;
    if (defaultDays !== null) {
        to ??= now;
        from ??= new Date(to.getTime() - defaultDays * 86_400_000);
    }
    if (from && to && from > to) return { error: 'from must not be later than to.' };
    if (maxDays !== null && from && to && to - from > maxDays * 86_400_000) return { error: `The time window may not exceed ${maxDays} days.` };
    return { from, to, error: null };
};
