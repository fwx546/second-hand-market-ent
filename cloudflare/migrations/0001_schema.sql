-- Independent Cloudflare D1 schema, with no user, product or demo rows.
-- Source migrations SHA-256: 8139501b2574811e407abfda82cd527370830517f7b5ff92a3dea76a907d3a2b
-- Regenerate/check with scripts/generate-cloudflare-schema.mjs.

CREATE TABLE `auth_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`binding_hash` text NOT NULL,
	`code_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_to` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);

CREATE TABLE `school_email_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`email_hash` text NOT NULL,
	`binding_hash` text NOT NULL,
	`code_hash` text NOT NULL,
	`email_masked` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "school_challenges_attempts" CHECK("school_email_challenges"."attempts" >= 0 AND "school_email_challenges"."attempts" <= 5),
	CONSTRAINT "school_challenges_delivery" CHECK("school_email_challenges"."delivery_status" IN ('pending', 'sent', 'failed'))
);

CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT '橘子同学' NOT NULL,
	`created_at` integer NOT NULL
, `campus` text DEFAULT '' NOT NULL, `publish_seller` text DEFAULT '' NOT NULL, `publish_contact_type` text DEFAULT '' NOT NULL, `publish_contact_value` text DEFAULT '' NOT NULL, `language` text DEFAULT 'zh' NOT NULL, `phone` text DEFAULT '' NOT NULL, `wechat` text DEFAULT '' NOT NULL, `qq` text DEFAULT '' NOT NULL);

CREATE TABLE `auth_sessions` (
	`session_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE "products" (
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
	CONSTRAINT "products_price_valid" CHECK("products"."price_cents" > 0 AND "products"."price_cents" <= 10000000 AND "products"."original_price_cents" >= 0 AND "products"."original_price_cents" <= 10000000),
	CONSTRAINT "products_status_valid" CHECK("products"."status" IN ('active', 'inactive')),
	CONSTRAINT "products_category_valid" CHECK("products"."category" IN ('appliance', 'ebike', 'daily')),
	CONSTRAINT "products_campus_valid" CHECK("products"."campus" IN ('SIP 校区', '太仓校区')),
	CONSTRAINT "products_condition_valid" CHECK("products"."condition" IN ('全新', '几乎全新', '轻微使用痕迹', '明显使用痕迹'))
);

CREATE TABLE `school_email_accounts` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email_masked` text NOT NULL,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `favorites` (
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `product_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `private_contacts` (
	`product_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "contacts_type_valid" CHECK("private_contacts"."type" IN ('wechat', 'phone', 'qq'))
);

CREATE TABLE `product_media` (
	`product_id` text NOT NULL,
	`media_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`product_id`, `media_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `auth_flows_expiry` ON `auth_flows` (`expires_at`);

CREATE INDEX `auth_sessions_expiry` ON `auth_sessions` (`expires_at`);

CREATE INDEX `auth_sessions_user` ON `auth_sessions` (`user_id`);

CREATE INDEX `conversations_buyer_updated` ON `conversations` (`buyer_id`,`updated_at`);

CREATE UNIQUE INDEX `conversations_product_buyer` ON `conversations` (`product_id`,`buyer_id`);

CREATE INDEX `conversations_seller_updated` ON `conversations` (`seller_id`,`updated_at`);

CREATE UNIQUE INDEX `media_object_key` ON `media` (`object_key`);

CREATE INDEX `media_owner` ON `media` (`owner_id`);

CREATE INDEX `messages_conversation_time` ON `messages` (`conversation_id`,`created_at`);

CREATE INDEX `product_media_lookup` ON `product_media` (`media_id`);

CREATE UNIQUE INDEX `product_media_position` ON `product_media` (`product_id`,`position`);

CREATE INDEX `products_owner` ON `products` (`owner_id`,`created_at`);

CREATE INDEX `products_public_feed` ON `products` (`status`,`created_at`,`id`);

CREATE INDEX `school_challenges_browser_created` ON `school_email_challenges` (`binding_hash`,`created_at`);

CREATE INDEX `school_challenges_created` ON `school_email_challenges` (`created_at`);

CREATE INDEX `school_challenges_email_created` ON `school_email_challenges` (`email_hash`,`created_at`);

CREATE UNIQUE INDEX `school_email_accounts_user` ON `school_email_accounts` (`user_id`);
