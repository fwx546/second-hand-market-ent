/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { handleMarket } from "../../../server/market.mjs";

export const dynamic = "force-dynamic";

async function route(request: Request) {
  const user = await getChatGPTUser();
  // Never forward account email/full name into public seller data.
  return handleMarket(request, env, user ? { userId: user.userId } : null, { development: import.meta.env.DEV });
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
