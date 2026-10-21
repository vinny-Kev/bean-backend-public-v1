export const breadcrumb = (action, message) => {
    console.log(`[BREADCRUMB][${action}]: ${message}`);
};

export const log = (action, message) => (req, res, next) => {
    breadcrumb(action, message);
    next();
};
