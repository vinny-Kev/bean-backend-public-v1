# Tenants, members, and tenant isolation

## Authority model

- **Account permissions** come from `users.role_id → role_permissions → permissions`. `requirePermission` checks them live on each request. They decide *what* a user may do: `TENANTS_CREATE`, `INTEGRATIONS_READ`, `INVENTORY_*`, and so on.
- **Tenant roles** come from `tenant_members.membership_role` (`owner`, `admin`, `member`). They decide *whose* data a user may touch and who manages membership. A tenant role never grants an account permission.
- A tenant ID in a URL is only a selector. `requireTenantMember` (`middleware/tenantAccessMiddleware.js`) resolves it against the caller's membership. Non-members and deleted tenants get `404`; a missing tenant role gets `403`.

## Tenant creation policy

`POST /tenants` requires the account permission `TENANTS_CREATE`. Migration 005 adds it and grants it to the `dev` role, which every existing account holds, so current access is unchanged. New signups have no role and cannot create tenants until a role with `TENANTS_CREATE` is assigned. There is no role-assignment API yet. The creator becomes the tenant's `owner` in the same transaction as the tenant insert and its `CREATE TENANT` audit entry.

## Endpoints

All of these require a session. Unsafe methods also require a trusted `Origin`.

| Method and path | Who | Notes |
|---|---|---|
| `GET /auth/me` | any session | `{ user: { id, email, username, roleId, permissions[] } }` |
| `POST /tenants` | `TENANTS_CREATE` | `{ name, slug }` → `201`; `409 TENANT_SLUG_TAKEN` |
| `GET /tenants` | any session | the caller's tenants and roles |
| `GET /tenants/:tenant_id` | member | tenant, caller's `membershipRole`, `memberCount` |
| `GET /tenants/:tenant_id/members` | member | paginated; ordered owners, admins, members |
| `GET /tenants/:tenant_id/members/:user_id` | member | `{ userId, username, email, membershipRole, joinedAt, accountStatus }` |
| `POST /tenants/:tenant_id/members` | owner, admin | `{ email \| username, role? }` adds an **existing active account**; there are no email invitations |
| `PATCH /tenants/:tenant_id/members/:user_id` | owner | `{ role }` |
| `DELETE /tenants/:tenant_id/members/:user_id` | owner, admin, or self | removing yourself means leaving |

Membership rules:
- **Owners** add members with any role, change other members' roles, and remove anyone else.
- **Admins** add and remove plain members only (`OWNER_REQUIRED` otherwise) and cannot change roles.
- **Members** can only leave.
- **Nobody** changes their own role (`CANNOT_CHANGE_OWN_ROLE`).
- **A tenant always keeps one owner** (`LAST_OWNER`). Ownership transfer: an owner promotes someone to owner, then leaves or is demoted by them.

Every change runs in one transaction that locks the tenant row and re-reads the caller's role, so concurrent changes cannot leave a tenant ownerless. Changes are audited as `ADD TENANT MEMBER`, `UPDATE TENANT MEMBER ROLE` and `REMOVE TENANT MEMBER`, with tenant, user and role only. Membership changes need an active tenant (`409 TENANT_INACTIVE`).

A member referenced by integration user mappings, sales referrals or commissions cannot be removed (`409 MEMBER_HAS_LINKED_RECORDS`). Those foreign keys are `RESTRICT`, and `tenant_members` has no deactivated state yet.

## Inventory isolation

Inventory routes are tenant-scoped and need both the account permission and tenant membership:

- `GET /inventory/tenants/:tenant_id/items` (`INVENTORY_READ`, paginated)
- `POST /inventory/tenants/:tenant_id/items` (`INVENTORY_CREATE`; active tenant)
- `PUT /inventory/tenants/:tenant_id/items/:id` (`INVENTORY_UPDATE`; active tenant)

All SQL filters on `tenant_id`, so another tenant's item IDs look exactly like missing ones. The old unscoped `/inventory/all`, `/inventory/add` and `/inventory/update/:id` routes were removed. Rows with `tenant_id IS NULL` (legacy data) are not reachable until they are assigned to a tenant.
