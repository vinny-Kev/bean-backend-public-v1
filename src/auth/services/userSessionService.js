import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { destroySession } from '../../util/sessionUtils.js'

export const loginUser = async (req, res) => {
    const sessionStartedAt = Date.now();
    console.log(`LOGIN SERVICE]: Session Start: ${sessionStartedAt}`);
    try {
        await new Promise((resolve, reject) => {
            req.session.userId = req.user.id;
            req.session.authenticatedAt = sessionStartedAt;
            req.session.regenerate((err) => {
                if(err) {
                    console.error('[LOGIN SERVICE]: End Process - Error regenerating session:', err);
                    return reject(err);
                }
                else resolve();
                });
            });
          
            await new Promise((resolve,reject) =>{
                req.session.save((error)=>{
                    if(error){
                        console.error('[LOGIN SERVICE]: End Process - Error regenerating session:', error);
                        reject(error);
                    } else resolve();
                });
            });

            console.log('[LOGIN SERVICE]: Compose Audit Logs');
            const auditEntry = auditLog({
                userId: req.user.id,
                action: `LOGIN_SUCCESS`,
                tableName: 'session',
                recordId: req.user.id,
            });
            await composeAuditLogs(auditEntry);
            console.log('[LOGIN SERVICE]: End Compose Audit Logs');

            req.session.userId = req.user.id;
            req.session.authenticatedAt = sessionStartedAt;
            console.log('[LOGIN SERVICE]: End Process SUCCESS - Login successful, session created.');
            console.log('[LOGIN SERVICE]: Session details:', { userId: req.session.userId});

            return res.status(200).json({
                message: 'Login successful.',
                user: req.user
            });
        } catch(error) {
            console.error("[LOGIN SERVICE]: End Process - Error during login:", error);
            return res.status(500).json({ message: 'Internal server error during login.' });
        }
    };

export const logoutUser = async (req, res) => {
    try {
        await destroySession(req);
        res.clearCookie('bean.sid', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/'
        });
        console.log("[LOGOUT SERVICE]: End Process SUCCESS - User logged out and session destroyed.");
        return res.status(204).json({message: 'User succesfully logged out.'}).send();
    } 
    catch(err) {
        console.error("[LOGOUT SERVICE]: End Process - Error during logout:", err);
        return res.status(500).json({ message: 'Internal server error during logout.' });
    }
}


