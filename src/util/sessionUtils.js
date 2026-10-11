export const destroySession = (req) => {
    return new Promise((resolve, reject)=> {
        req.session.destroy((error) => {
            if(error){
                console.error('[DESTROY SERVICE]: End Process - Error destroying session:', error);
                return reject(error);
            }
            resolve();
        });
    });
}

