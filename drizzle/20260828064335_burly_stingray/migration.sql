PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_integrations` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`credential_key` text,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "integrations_type_check" CHECK("type" in ('email', 'telegram')),
	CONSTRAINT "integrations_mode_check" CHECK("mode" in ('local-outbox', 'resend', 'bot')),
	CONSTRAINT "integrations_status_check" CHECK("status" in ('connected', 'disconnected', 'error'))
);
--> statement-breakpoint
INSERT INTO `__new_integrations`(`id`, `type`, `name`, `mode`, `status`, `credential_key`, `config_json`, `created_at`, `updated_at`) SELECT `id`, `type`, `name`, `mode`, `status`, `credential_key`, `config_json`, `created_at`, `updated_at` FROM `integrations`;--> statement-breakpoint
DROP TABLE `integrations`;--> statement-breakpoint
ALTER TABLE `__new_integrations` RENAME TO `integrations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;