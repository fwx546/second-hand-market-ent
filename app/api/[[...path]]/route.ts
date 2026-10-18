/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser } from "../../chatgpt-auth";
import { handleMarket } from "../../../server/market.mjs";
import { getExternalAuthConfig, handleExternalAuth, resolveExternalViewer } from "../../../server/external-auth.mjs";

export const dynamic = "force-dynamic";

async function route(request: Request) {
  const development = import.meta.env.DEV;
  const authResponse = await handleExternalAuth(request, env, { development });
  if (authResponse) return authResponse;
  const external = await resolveExternalViewer(request, env, { development });
  const user = external ? null : await getChatGPTUser();
  const viewer = external || (user ? { userId: user.userId } : null);
  // Never forward account email/full name into public seller data.
  return handleMarket(request, env, viewer, {
    development,
    authentication: {
      provider: external ? "external" : user ? "chatgpt" : null,
      external: getExternalAuthConfig(env, { development }),
      platform: { enabled: true, signInUrl: chatGPTSignInPath("/#/"), signOutUrl: chatGPTSignOutPath("/") },
    },
  });
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
