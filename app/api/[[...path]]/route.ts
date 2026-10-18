/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { handleMarket } from "../../../server/market.mjs";
import { getSchoolAuthConfig, handleSchoolAuth, resolveSchoolViewer } from "../../../server/school-auth.mjs";

export const dynamic = "force-dynamic";

async function route(request: Request) {
  const development = import.meta.env.DEV;
  const authResponse = await handleSchoolAuth(request, env, { development });
  if (authResponse) return authResponse;
  // Host ChatGPT/Seedy identity and retired OIDC cookies never grant school-email permissions.
  const viewer = await resolveSchoolViewer(request, env, { development });
  return handleMarket(request, env, viewer, {
    development,
    authentication: {
      provider: viewer ? "school_email" : "guest",
      email: getSchoolAuthConfig(env, { development }),
      guest: { enabled: true, startUrl: "/api/auth/guest" },
    },
  });
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
