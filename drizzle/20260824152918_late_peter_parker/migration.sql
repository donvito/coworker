CREATE TABLE `discussion_sessions` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`participant_ids_json` text NOT NULL,
	`next_turn` integer NOT NULL,
	`turn_limit` integer NOT NULL,
	`hard_limit` integer DEFAULT 8 NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_discussion_sessions_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "discussion_sessions_status_check" CHECK("status" in ('active', 'awaiting_user', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "discussion_sessions_next_turn_check" CHECK("next_turn" >= 0),
	CONSTRAINT "discussion_sessions_turn_limit_check" CHECK("turn_limit" > 0),
	CONSTRAINT "discussion_sessions_hard_limit_check" CHECK("hard_limit" >= "turn_limit")
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `discussion_id` text REFERENCES discussion_sessions(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `discussion_turn` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_source_message_coworker_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_message_coworker_idx` ON `tasks` (`source_message_id`,`coworker_id`) WHERE "tasks"."source_message_id" is not null and "tasks"."discussion_id" is null;--> statement-breakpoint
CREATE INDEX `discussion_sessions_conversation_idx` ON `discussion_sessions` (`conversation_id`,"updated_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `discussion_sessions_source_message_idx` ON `discussion_sessions` (`source_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_discussion_turn_idx` ON `tasks` (`discussion_id`,`discussion_turn`) WHERE "tasks"."discussion_id" is not null;