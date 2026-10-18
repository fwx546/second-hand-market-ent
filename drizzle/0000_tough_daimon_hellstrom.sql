CREATE TABLE `favorites` (
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `product_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_object_key` ON `media` (`object_key`);--> statement-breakpoint
CREATE INDEX `media_owner` ON `media` (`owner_id`);--> statement-breakpoint
CREATE TABLE `private_contacts` (
	`product_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "contacts_type_valid" CHECK("private_contacts"."type" IN ('wechat', 'phone', 'qq'))
);
--> statement-breakpoint
CREATE TABLE `product_media` (
	`product_id` text NOT NULL,
	`media_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`product_id`, `media_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_media_position` ON `product_media` (`product_id`,`position`);--> statement-breakpoint
CREATE INDEX `product_media_lookup` ON `product_media` (`media_id`);--> statement-breakpoint
CREATE TABLE `products` (
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
	`seller` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "products_price_valid" CHECK("products"."price_cents" > 0 AND "products"."price_cents" <= 10000000 AND "products"."original_price_cents" >= 0 AND "products"."original_price_cents" <= 10000000),
	CONSTRAINT "products_status_valid" CHECK("products"."status" IN ('active', 'inactive')),
	CONSTRAINT "products_category_valid" CHECK("products"."category" IN ('appliance', 'ebike', 'daily')),
	CONSTRAINT "products_campus_valid" CHECK("products"."campus" IN ('SIP 校区', '太仓校区')),
	CONSTRAINT "products_condition_valid" CHECK("products"."condition" IN ('几乎全新', '九成新', '八成新'))
);
--> statement-breakpoint
CREATE INDEX `products_public_feed` ON `products` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `products_owner` ON `products` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT '橘子同学' NOT NULL,
	`created_at` integer NOT NULL
);
