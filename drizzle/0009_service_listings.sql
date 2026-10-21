PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__service_backup_private_contacts` AS SELECT * FROM `private_contacts`;--> statement-breakpoint
CREATE TABLE `__service_backup_product_media` AS SELECT * FROM `product_media`;--> statement-breakpoint
CREATE TABLE `__service_backup_favorites` AS SELECT * FROM `favorites`;--> statement-breakpoint
CREATE TABLE `__service_backup_conversations` AS SELECT * FROM `conversations`;--> statement-breakpoint
CREATE TABLE `__service_backup_messages` AS SELECT * FROM `messages`;--> statement-breakpoint

CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`price_cents` integer NOT NULL,
	`original_price_cents` integer NOT NULL,
	`condition` text NOT NULL,
	`campus` text NOT NULL,
	`location` text NOT NULL,
	`description` text NOT NULL,
	`specs_json` text NOT NULL,
	`graduation` integer DEFAULT false NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`seller` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sold_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "products_price_valid" CHECK("__new_products"."price_cents" > 0 AND "__new_products"."price_cents" <= 10000000 AND "__new_products"."original_price_cents" >= 0 AND "__new_products"."original_price_cents" <= 10000000),
	CONSTRAINT "products_status_valid" CHECK("__new_products"."status" IN ('active', 'inactive')),
	CONSTRAINT "products_category_valid" CHECK("__new_products"."category" IN ('appliance', 'ebike', 'daily', 'service')),
	CONSTRAINT "products_campus_valid" CHECK("__new_products"."campus" IN ('SIP 校区', '太仓校区')),
	CONSTRAINT "products_condition_valid" CHECK(("__new_products"."category" = 'service' AND "__new_products"."condition" = '不适用') OR ("__new_products"."category" <> 'service' AND "__new_products"."condition" IN ('全新', '几乎全新', '轻微使用痕迹', '明显使用痕迹')))
);--> statement-breakpoint

INSERT INTO `__new_products`("id", "owner_id", "title", "category", "price_cents", "original_price_cents", "condition", "campus", "location", "description", "specs_json", "graduation", "is_demo", "seller", "status", "sold_at", "deleted_at", "created_at", "updated_at") SELECT "id", "owner_id", "title", "category", "price_cents", "original_price_cents", "condition", "campus", "location", "description", "specs_json", "graduation", "is_demo", "seller", "status", "sold_at", "deleted_at", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint

CREATE INDEX `products_public_feed` ON `products` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `products_owner` ON `products` (`owner_id`,`created_at`);--> statement-breakpoint
INSERT INTO `private_contacts` SELECT * FROM `__service_backup_private_contacts`;--> statement-breakpoint
INSERT INTO `product_media` SELECT * FROM `__service_backup_product_media`;--> statement-breakpoint
INSERT INTO `favorites` SELECT * FROM `__service_backup_favorites`;--> statement-breakpoint
INSERT INTO `conversations` SELECT * FROM `__service_backup_conversations`;--> statement-breakpoint
INSERT INTO `messages` SELECT * FROM `__service_backup_messages`;--> statement-breakpoint
DROP TABLE `__service_backup_messages`;--> statement-breakpoint
DROP TABLE `__service_backup_conversations`;--> statement-breakpoint
DROP TABLE `__service_backup_favorites`;--> statement-breakpoint
DROP TABLE `__service_backup_product_media`;--> statement-breakpoint
DROP TABLE `__service_backup_private_contacts`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint