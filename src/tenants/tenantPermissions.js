// Organization-level permissions derived from the membership role (owner / admin / member).
//
// Effective access to a tenant-scoped action is:
//     the account role grants the permission (legacy / platform accounts, unchanged)
//  OR (account has no role or the default "standard" role) the caller's membership role in THAT tenant
//     grants it (this table). Accounts with any other role are never elevated by their membership.
// So a user who is only a plain member of company B gets exactly the "member" permissions there,
// regardless of any role they hold elsewhere. Routes still verify membership and, where an action is
// owner/admin-only, the exact membership role.
const readOnly = ['INVENTORY_READ'];
const manage = ['INVENTORY_READ', 'INVENTORY_CREATE', 'INVENTORY_UPDATE', 'INTEGRATIONS_READ', 'INTEGRATIONS_MANAGE', 'AUDIT_READ'];

export const TENANT_ROLE_PERMISSIONS = Object.freeze({
    member: Object.freeze(readOnly),
    admin: Object.freeze(manage),
    owner: Object.freeze(manage),
});

export const tenantRoleHasPermission = (role, permission) => TENANT_ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
