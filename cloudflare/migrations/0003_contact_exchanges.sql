CREATE TABLE `contact_exchanges` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`requester_type` text NOT NULL,
	`requester_value` text NOT NULL,
	`responder_type` text,
	`responder_value` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "contact_exchanges_status" CHECK("contact_exchanges"."status" IN ('pending', 'accepted', 'declined', 'cancelled', 'revoked', 'expired')),
	CONSTRAINT "contact_exchanges_requester_type" CHECK("contact_exchanges"."requester_type" IN ('wechat', 'phone', 'qq')),
	CONSTRAINT "contact_exchanges_responder_type" CHECK("contact_exchanges"."responder_type" IS NULL OR "contact_exchanges"."responder_type" IN ('wechat', 'phone', 'qq')),
	CONSTRAINT "contact_exchanges_consent_values" CHECK(("contact_exchanges"."status" NOT IN ('pending', 'accepted') OR length("contact_exchanges"."requester_value") BETWEEN 3 AND 80) AND ("contact_exchanges"."status" <> 'accepted' OR ("contact_exchanges"."responder_type" IS NOT NULL AND "contact_exchanges"."responder_value" IS NOT NULL AND length("contact_exchanges"."responder_value") BETWEEN 3 AND 80)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_exchanges_active_conversation` ON `contact_exchanges` (`conversation_id`) WHERE "contact_exchanges"."status" IN ('pending', 'accepted');--> statement-breakpoint
CREATE INDEX `contact_exchanges_requester_time` ON `contact_exchanges` (`requester_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_exchanges_conversation_time` ON `contact_exchanges` (`conversation_id`,`created_at`);