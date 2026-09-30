import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { auditLog } from '../../audit_logs/auditLog.js';

export const loginUserService = async (req, res) => {
    try {
        await new Promise((resolve, reject) => {
            req.session.regenerate((err) => {
                if(err) {
                    console.error('[LOGIN SERVICE]: End Process - Error regenerating session:', err);
                    return reject(err);
                }
                else resolve();
                });
            });
            req.session.userId = req.user.id;
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

            console.log('[LOGIN SERVICE]: End Process SUCCESS - Login successful, session created.');
            console.log('[LOGIN SERVICE]: Session details:', { userId: req.session.userId, role: req.session.role });
            return res.status(200).json({
                message: 'Login successful.',
                user: req.user
            });
        } catch(error) {
            console.error("[LOGIN SERVICE]: End Process - Error during login:", error);
            return res.status(500).json({ message: 'Internal server error during login.' });
        }
    };
