PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`coworker_id` text,
	`author_name` text NOT NULL,
	`task_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_messages_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_messages_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT "messages_role_check" CHECK("role" in ('user', 'assistant', 'system', 'tool'))
);
--> statement-breakpoint
INSERT INTO `__new_messages`(`id`, `conversation_id`, `coworker_id`, `author_name`, `task_id`, `role`, `content`, `created_at`) SELECT `id`, `conversation_id`, `coworker_id`, `author_name`, `task_id`, `role`, `content`, `created_at` FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `messages_conversation_created_idx` ON `messages` (`conversation_id`,"created_at" asc);