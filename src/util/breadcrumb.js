export const log = (action, message) => (req, res, next)=> {
    console.log(`[BREADCRUMB][${action}]: ${message}`);
    next();
}

