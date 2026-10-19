ALTER TABLE `users` ADD `language` text DEFAULT 'zh' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `phone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `wechat` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `qq` text DEFAULT '' NOT NULL;