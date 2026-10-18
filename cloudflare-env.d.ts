declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    JUZI_AUTH_ISSUER?: string;
    JUZI_AUTH_CLIENT_ID?: string;
    JUZI_AUTH_CLIENT_SECRET?: string;
    JUZI_AUTH_TOKEN_AUTH_METHOD?: string;
    JUZI_AUTH_ORIGIN?: string;
    JUZI_AUTH_PHONE_ENABLED?: string;
    JUZI_AUTH_WECHAT_ENABLED?: string;
  }
}
