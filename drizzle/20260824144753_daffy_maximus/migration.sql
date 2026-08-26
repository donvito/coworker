PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY,
	`coworker_id` text,
	`kind` text DEFAULT 'direct' NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_conversations_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT "conversations_kind_check" CHECK("kind" in ('direct', 'group'))
);--> statement-breakpoint
INSERT INTO `__new_conversations`(`id`, `coworker_id`, `kind`, `title`, `created_at`, `updated_at`)
SELECT `id`, `coworker_id`, 'direct', `title`, `created_at`, `updated_at`
FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`conversation_id` text NOT NULL,
	`coworker_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `conversation_members_pk` PRIMARY KEY(`conversation_id`, `coworker_id`),
	CONSTRAINT `fk_conversation_members_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_members_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
INSERT OR IGNORE INTO `conversation_members`(`conversation_id`, `coworker_id`, `created_at`)
SELECT `id`, `coworker_id`, `created_at`
FROM `conversations`
WHERE `coworker_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `conversation_members`(`conversation_id`, `coworker_id`, `created_at`)
SELECT `thread_id`, `coworker_id`, MIN(`created_at`)
FROM `tasks`
WHERE `thread_id` IS NOT NULL AND `thread_id` <> ''
GROUP BY `thread_id`, `coworker_id`;--> statement-breakpoint
UPDATE `conversations`
SET
	`kind` = 'group',
	`coworker_id` = NULL
WHERE (
	SELECT COUNT(*) FROM `conversation_members`
	WHERE `conversation_members`.`conversation_id` = `conversations`.`id`
) > 1;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY,
	`coworker_id` text NOT NULL,
	`schedule_id` text,
	`run_id` text,
	`thread_id` text,
	`source_message_id` text,
	`title` text NOT NULL,
	`input` text NOT NULL,
	`status` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	CONSTRAINT `fk_tasks_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_schedule_id_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tasks_thread_id_conversations_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "tasks_status_check" CHECK("status" in ('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "tasks_source_check" CHECK("source" in ('manual', 'schedule', 'recovery'))
);--> statement-breakpoint
INSERT INTO `__new_tasks`(
	`id`, `coworker_id`, `schedule_id`, `run_id`, `thread_id`, `source_message_id`,
	`title`, `input`, `status`, `source`, `priority`, `result`, `error`,
	`created_at`, `started_at`, `completed_at`
)
SELECT
	`id`, `coworker_id`, `schedule_id`, `run_id`,
	COALESCE(NULLIF(`thread_id`, ''), 'coworker:' || `coworker_id`),
	NULL, `title`, `input`, `status`, `source`, `priority`, `result`, `error`,
	`created_at`, `started_at`, `completed_at`
FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
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
);--> statement-breakpoint
INSERT INTO `__new_messages`(
	`id`, `conversation_id`, `coworker_id`, `author_name`,
	`task_id`, `role`, `content`, `created_at`
)
SELECT
	`messages`.`id`,
	COALESCE(`tasks`.`thread_id`, 'coworker:' || `messages`.`coworker_id`),
	CASE WHEN `messages`.`role` = 'user' THEN NULL ELSE `messages`.`coworker_id` END,
	CASE
		WHEN `messages`.`role` = 'user' THEN 'You'
		ELSE COALESCE(`coworkers`.`name`, 'Workroom')
	END,
	`messages`.`task_id`,
	`messages`.`role`,
	`messages`.`content`,
	`messages`.`created_at`
FROM `messages`
LEFT JOIN `tasks` ON `tasks`.`id` = `messages`.`task_id`
LEFT JOIN `coworkers` ON `coworkers`.`id` = `messages`.`coworker_id`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
UPDATE `tasks`
SET `source_message_id` = (
	SELECT `messages`.`id`
	FROM `messages`
	WHERE `messages`.`task_id` = `tasks`.`id`
	  AND `messages`.`role` = 'user'
	ORDER BY `messages`.`created_at`, `messages`.`id`
	LIMIT 1
);--> statement-breakpoint
CREATE TABLE `message_mentions` (
	`message_id` text NOT NULL,
	`coworker_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `message_mentions_pk` PRIMARY KEY(`message_id`, `coworker_id`),
	CONSTRAINT `fk_message_mentions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_mentions_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
INSERT OR IGNORE INTO `message_mentions`(`message_id`, `coworker_id`, `created_at`)
SELECT `source_message_id`, `coworker_id`, `created_at`
FROM `tasks`
WHERE `source_message_id` IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `conversations_coworker_updated_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `messages_coworker_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_run_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_coworker_queue_idx`;--> statement-breakpoint
CREATE INDEX `conversations_coworker_updated_idx` ON `conversations` (`coworker_id`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `conversation_members_coworker_idx` ON `conversation_members` (`coworker_id`,`conversation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_run_id_idx` ON `tasks` (`run_id`) WHERE "tasks"."run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_message_coworker_idx` ON `tasks` (`source_message_id`,`coworker_id`) WHERE "tasks"."source_message_id" is not null;--> statement-breakpoint
CREATE INDEX `tasks_coworker_queue_idx` ON `tasks` (`coworker_id`,`status`,"priority" desc,"created_at" asc);--> statement-breakpoint
CREATE INDEX `messages_conversation_created_idx` ON `messages` (`conversation_id`,"created_at" asc);--> statement-breakpoint
CREATE INDEX `message_mentions_coworker_idx` ON `message_mentions` (`coworker_id`,`message_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
