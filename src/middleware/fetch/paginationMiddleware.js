const parseInteger = (value) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        return null;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

export const paginationMiddleware = (req, res, next) => {
    const { page: rawPage, limit: rawLimit, offset: rawOffset } = req.query;
    const hasPage = rawPage !== undefined;
    const hasLimit = rawLimit !== undefined;
    const hasOffset = rawOffset !== undefined;
    const hasPagination = hasPage || hasLimit || hasOffset;

    if (!hasPagination) {
        req.pagination = null;
        return next();
    }

    if (hasPage && hasOffset) {
        return res.status(400).json({ message: 'Use either page or offset, not both.' });
    }

    const limit = hasLimit ? parseInteger(rawLimit) : 20;
    if (limit === null || limit < 1 || limit > 20) {
        return res.status(400).json({
            message: 'The limit must be an integer between 1 and 20.',
        });
    }

    let page;
    let offset = 0;
    if (hasPage) {
        page = parseInteger(rawPage);
        if (page === null || page < 1) {
            return res.status(400).json({ message: 'The page must be a positive integer.' });
        }

        offset = (page - 1) * limit;
        if (!Number.isSafeInteger(offset)) {
            return res.status(400).json({ message: 'The requested page is too large.' });
        }
    } else if (hasOffset) {
        offset = parseInteger(rawOffset);
        if (offset === null) {
            return res.status(400).json({
                message: 'The offset must be a non-negative integer.',
            });
        }
    }

    req.pagination = { page, limit, offset };
    return next();
};
