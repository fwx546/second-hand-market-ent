CREATE TABLE `school_email_accounts` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email_masked` text NOT NULL,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `school_email_accounts_user` ON `school_email_accounts` (`user_id`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `school_challenges_email_created` ON `school_email_challenges` (`email_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `school_challenges_browser_created` ON `school_email_challenges` (`binding_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `school_challenges_created` ON `school_email_challenges` (`created_at`);