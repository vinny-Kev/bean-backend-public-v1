export const destroySession = (req) => new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve());
});
