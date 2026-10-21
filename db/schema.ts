import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Platform identity is private. Public seller names come from the listing form.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull().default("橘子同学"),
  campus: text("campus").notNull().default(""),
  publishSeller: text("publish_seller").notNull().default(""),
  publishContactType: text("publish_contact_type").notNull().default(""),
  publishContactValue: text("publish_contact_value").notNull().default(""),
  language: text("language").notNull().default("zh"),
  phone: text("phone").notNull().default(""),
  wechat: text("wechat").notNull().default(""),
  qq: text("qq").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  category: text("category").notNull(),
  priceCents: integer("price_cents").notNull(),
  originalPriceCents: integer("original_price_cents").notNull(),
  condition: text("condition").notNull(),
  campus: text("campus").notNull(),
  location: text("location").notNull(),
  description: text("description").notNull(),
  specsJson: text("specs_json").notNull(),
  graduation: integer("graduation", { mode: "boolean" }).notNull().default(false),
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  seller: text("seller").notNull(),
  status: text("status").notNull().default("active"),
  soldAt: integer("sold_at"),
  deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("products_public_feed").on(table.status, table.createdAt, table.id),
  index("products_owner").on(table.ownerId, table.createdAt),
  check("products_price_valid", sql`${table.priceCents} > 0 AND ${table.priceCents} <= 10000000 AND ${table.originalPriceCents} >= 0 AND ${table.originalPriceCents} <= 10000000`),
  check("products_status_valid", sql`${table.status} IN ('active', 'inactive')`),
  check("products_category_valid", sql`${table.category} IN ('appliance', 'ebike', 'daily', 'service')`),
  check("products_campus_valid", sql`${table.campus} IN ('SIP 校区', '太仓校区')`),
  check("products_condition_valid", sql`(${table.category} = 'service' AND ${table.condition} = '不适用') OR (${table.category} <> 'service' AND ${table.condition} IN ('全新', '几乎全新', '轻微使用痕迹', '明显使用痕迹'))`),
]);

export const privateContacts = sqliteTable("private_contacts", {
  productId: text("product_id").primaryKey().references(() => products.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  value: text("value").notNull(),
}, (table) => [check("contacts_type_valid", sql`${table.type} IN ('wechat', 'phone', 'qq')`)]);

export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("media_object_key").on(table.objectKey),
  index("media_owner").on(table.ownerId),
]);

export const productMedia = sqliteTable("product_media", {
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  mediaId: text("media_id").notNull().references(() => media.id),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.productId, table.mediaId] }),
  uniqueIndex("product_media_position").on(table.productId, table.position),
  index("product_media_lookup").on(table.mediaId),
]);

export const favorites = sqliteTable("favorites", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.productId] })]);

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  buyerId: text("buyer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sellerId: text("seller_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("conversations_product_buyer").on(table.productId, table.buyerId),
  index("conversations_buyer_updated").on(table.buyerId, table.updatedAt),
  index("conversations_seller_updated").on(table.sellerId, table.updatedAt),
]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("messages_conversation_time").on(table.conversationId, table.createdAt)]);

// Ten-minute, browser-bound, one-use OIDC transactions. No provider tokens or profile data.
export const authFlows = sqliteTable("auth_flows", {
  stateHash: text("state_hash").primaryKey(),
  bindingHash: text("binding_hash").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  nonce: text("nonce").notNull(),
  issuer: text("issuer").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("auth_flows_expiry").on(table.expiresAt)]);

// Only SHA-256 of the browser's random opaque session token is stored.
export const authSessions = sqliteTable("auth_sessions", {
  sessionHash: text("session_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("auth_sessions_expiry").on(table.expiresAt),
  index("auth_sessions_user").on(table.userId),
]);

// Verifies control of a student mailbox, not current enrollment or a school endorsement.
export const schoolEmailAccounts = sqliteTable("school_email_accounts", {
  emailHash: text("email_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  emailMasked: text("email_masked").notNull(),
  verifiedAt: integer("verified_at").notNull(),
}, (table) => [uniqueIndex("school_email_accounts_user").on(table.userId)]);

// Keep every send reservation (including failures) for 24 hours to enforce delivery budgets.
export const schoolEmailChallenges = sqliteTable("school_email_challenges", {
  id: text("id").primaryKey(),
  emailHash: text("email_hash").notNull(),
  bindingHash: text("binding_hash").notNull(),
  codeHash: text("code_hash").notNull(),
  emailMasked: text("email_masked").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  consumedAt: integer("consumed_at"),
  deliveryStatus: text("delivery_status").notNull().default("pending"),
}, (table) => [
  index("school_challenges_email_created").on(table.emailHash, table.createdAt),
  index("school_challenges_browser_created").on(table.bindingHash, table.createdAt),
  index("school_challenges_created").on(table.createdAt),
  check("school_challenges_attempts", sql`${table.attempts} >= 0 AND ${table.attempts} <= 5`),
  check("school_challenges_delivery", sql`${table.deliveryStatus} IN ('pending', 'sent', 'failed')`),
]);
