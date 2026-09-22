import type { AuthSession } from "auth-kit";
import type { AuthKit, AuthKitOptions } from "auth-kit/server";
import type { AuthClient } from "auth-kit/react";
import { createAuthSchema, type AuthSchema } from "auth-kit/schema";

declare const kit: AuthKit;
declare const options: AuthKitOptions;
declare const client: AuthClient;

const session: Promise<AuthSession | null> = kit.getSession(new Request("http://localhost"));
const hostIp: string | Promise<string> = options.resolveClientIp(new Request("http://localhost"));
const clientSession = client.getSession();
const schema: AuthSchema = createAuthSchema("auth_kit");

void [session, hostIp, clientSession, schema];
