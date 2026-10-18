declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    JUZI_EMAIL_ENABLED?: string;
    JUZI_EMAIL_ORIGIN?: string;
    JUZI_EMAIL_FROM?: string;
    RESEND_API_KEY?: string;
    JUZI_EMAIL_AUTH_SECRET?: string;
    JUZI_EMAIL_DAILY_LIMIT?: string;
  }
}
