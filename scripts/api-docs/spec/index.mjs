import { audit, auth, health, inventory, tenants } from './core.mjs';
import { integrations } from './integrations.mjs';
import { tickets } from './tickets.mjs';
import { identityAuth, invitations, tenantIdentity } from './identity.mjs';

export const endpoints = [...health, ...auth.filter((e) => !['auth.signup', 'auth.login', 'auth.me'].includes(e.key)), ...identityAuth, ...tenants, ...tenantIdentity, ...invitations, ...inventory, ...audit, ...integrations, ...tickets];
export const folderOrder = ['Health', 'Authentication', 'Tenants', 'Invitations', 'Inventory', 'Audit', 'Integrations', 'Tickets'];

export const unsafe = (endpoint) => !['GET', 'HEAD', 'OPTIONS'].includes(endpoint.method);
// Integration event delivery is server-to-server: no session, no origin check.
export const isIngestion = (endpoint) => endpoint.key === 'integrations.events.ingest';
export const routeKey = (endpoint) => `${endpoint.method} ${endpoint.path.replace(/\/+$/, '').replace(/:[A-Za-z_]+/g, ':p')}`;
export const successStatus = (endpoint) => endpoint.responses.find((response) => response.status < 300).status;
export const expectedStatuses = (endpoint) => endpoint.expectedStatuses ?? [successStatus(endpoint)];

export const collectionVariables = {
    baseUrl: 'http://localhost:3000',
    origin: 'http://localhost:5173',
    signupFullName: 'QA Tester', signupUsername: '', signupEmail: '', signupPassword: '', signupUserId: '',
    verificationCode: '', loginChallengeId: '', loginCode: '', resetToken: '', newPassword: '', newEmail: '', emailChangeCode: '',
    invitationEmail: '', invitationId: '', invitationToken: '', transferCode: '', newOwnerUserId: '',
    userEmail: '', userPassword: '', currentUserId: '',
    inviteEmail: '', newTenantSlug: '', tenantId: '', memberUserId: '',
    itemId: '', itemSku: '',
    integrationId: '', integrationAppKey: '', integrationCredential: '', externalEventId: '', eventOccurredAt: '', internalEventId: '',
    inboxId: '', inboxEmail: '', ticketId: '', verificationId: '',
};
// Variables that must be supplied by the tester (kept out of the committed collection).
export const secretVariables = ['signupPassword', 'userPassword', 'integrationCredential', 'newPassword', 'resetToken', 'invitationToken', 'verificationCode', 'loginCode', 'emailChangeCode', 'transferCode'];
