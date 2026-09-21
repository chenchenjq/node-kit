# Next.js reference host

Copy the route pattern into a host application; it is intentionally not a package runtime dependency. Resolve the authenticated tenant and permissions from server-side request state rather than the illustrative JSON body, validate/lock the host SPU first, and apply the package migration before handling writes.
