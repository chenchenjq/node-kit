import { createAreaClient, type AreaAdminClient } from "area-kit/client";

/** Creates the browser client lazily so static example pages do not contact a host. */
export function createBrowserAreaClient(baseURL = "/api/area-kit"): AreaAdminClient {
  return createAreaClient({baseURL});
}
