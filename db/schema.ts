import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Platform identity is private. Public seller names come from the listing form.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull().default("橘子同学"),
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
  seller: text("seller").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("products_public_feed").on(table.status, table.createdAt, table.id),
  index("products_owner").on(table.ownerId, table.createdAt),
  check("products_price_valid", sql`${table.priceCents} > 0 AND ${table.priceCents} <= 10000000 AND ${table.originalPriceCents} >= 0 AND ${table.originalPriceCents} <= 10000000`),
  check("products_status_valid", sql`${table.status} IN ('active', 'inactive')`),
  check("products_category_valid", sql`${table.category} IN ('appliance', 'ebike', 'daily')`),
  check("products_campus_valid", sql`${table.campus} IN ('SIP 校区', '太仓校区')`),
  check("products_condition_valid", sql`${table.condition} IN ('几乎全新', '九成新', '八成新')`),
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
