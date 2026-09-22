import { getDemoAuth } from "../../../../lib/auth";
export const runtime = "nodejs";
export const GET = (request: Request) => getDemoAuth().handler(request);
export const POST = GET;
