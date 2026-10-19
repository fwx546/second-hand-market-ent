/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { handleMarket } from "../../../server/market.mjs";
import { getSchoolAuthConfig, handleSchoolAuth, resolveSchoolViewer } from "../../../server/school-auth.mjs";
import { handleLocalPreview, resolveLocalPreviewViewer } from "../../../server/local-preview.mjs";

export const dynamic = "force-dynamic";

async function route(request: Request) {
  const development = import.meta.env.DEV;
  const previewResponse = await handleLocalPreview(request, env, { development });
  if (previewResponse) return previewResponse;
  const authResponse = await handleSchoolAuth(request, env, { development });
  if (authResponse) return authResponse;
  // Host ChatGPT/Seedy identity and retired OIDC cookies never grant school-email permissions.
  const viewer = await resolveSchoolViewer(request, env, { development }) || resolveLocalPreviewViewer(request, { development });
  return handleMarket(request, env, viewer, {
    development,
    authentication: {
      provider: viewer?.provider || "guest",
      email: getSchoolAuthConfig(env, { development }),
      guest: { enabled: true, startUrl: "/api/auth/guest" },
      preview: { enabled: development === true && new URL(request.url).hostname === "localhost", startUrl: "/api/auth/preview" },
    },
  });
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
