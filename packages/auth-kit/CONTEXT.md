# Authentication context

auth-kit manages credential verification and session establishment for a host application. The host remains the authority for business users, tenants, roles, and permissions.

## Language

**Authentication user**:
The package identity associated with one globally unique mainland-China mobile number. A host maps it to its own business user.
_Avoid_: Tenant user, role holder

**SMS challenge**:
A time-limited, single-use verification attempt for a specific mobile number and authentication purpose.
_Avoid_: Login session, permanent code

**Authentication session**:
A time-limited signed-in state issued after a successful credential check. The host still determines business access.
_Avoid_: Authorization grant, tenant membership
