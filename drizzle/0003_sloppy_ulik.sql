ALTER TABLE `products` ADD `sold_at` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `campus` text DEFAULT '' NOT NULL;