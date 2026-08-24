CREATE TABLE IF NOT EXISTS `activity` (
	`id` text PRIMARY KEY,
	`coworker_id` text,
	`task_id` text,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_activity_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_activity_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `app_metadata` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `approvals` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`coworker_id` text NOT NULL,
	`tool_call_id` text NOT NULL UNIQUE,
	`action_type` text NOT NULL,
	`summary` text NOT NULL,
	`proposed_payload_json` text,
	`decided_payload_json` text,
	`risk_level` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	CONSTRAINT `fk_approvals_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_approvals_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_approvals_tool_call_id_tool_calls_id_fk` FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON DELETE CASCADE,
	CONSTRAINT "approvals_risk_level_check" CHECK("risk_level" in ('low', 'medium', 'high')),
	CONSTRAINT "approvals_status_check" CHECK("status" in ('PENDING', 'APPROVED', 'REJECTED', 'EDITED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `artifacts` (
	`id` text PRIMARY KEY,
	`task_id` text,
	`coworker_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_path` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_artifacts_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_artifacts_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY,
	`coworker_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_conversations_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `coworker_skills` (
	`coworker_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `coworker_skills_pk` PRIMARY KEY(`coworker_id`, `skill_id`),
	CONSTRAINT `fk_coworker_skills_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_coworker_skills_skill_id_skills_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `coworkers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`description` text,
	`system_prompt` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`runtime_status` text DEFAULT 'STOPPED' NOT NULL,
	`workspace_path` text NOT NULL,
	`enabled_tools_json` text DEFAULT '[]' NOT NULL,
	`policies_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "coworkers_status_check" CHECK("status" in ('active', 'paused')),
	CONSTRAINT "coworkers_runtime_status_check" CHECK("runtime_status" in ('STOPPED', 'STARTING', 'IDLE', 'WORKING', 'WAITING_FOR_APPROVAL', 'ERROR'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `integrations` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`credential_key` text,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "integrations_type_check" CHECK("type" = 'email'),
	CONSTRAINT "integrations_mode_check" CHECK("mode" in ('local-outbox', 'resend')),
	CONSTRAINT "integrations_status_check" CHECK("status" in ('connected', 'disconnected', 'error'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` text PRIMARY KEY,
	`coworker_id` text NOT NULL,
	`task_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_messages_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_messages_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "messages_role_check" CHECK("role" in ('user', 'assistant', 'system', 'tool'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `schedules` (
	`id` text PRIMARY KEY,
	`coworker_id` text NOT NULL,
	`name` text NOT NULL,
	`schedule_type` text NOT NULL,
	`cron_expression` text,
	`run_at` text,
	`timezone` text NOT NULL,
	`task_template_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_schedules_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT "schedules_type_check" CHECK("schedule_type" in ('cron', 'once')),
	CONSTRAINT "schedules_enabled_check" CHECK("enabled" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `schema_migrations` (
	`version` integer PRIMARY KEY,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `side_effects` (
	`idempotency_key` text PRIMARY KEY,
	`tool_call_id` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT `fk_side_effects_tool_call_id_tool_calls_id_fk` FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON DELETE CASCADE,
	CONSTRAINT "side_effects_status_check" CHECK("status" in ('RUNNING', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skill_resources` (
	`skill_id` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text NOT NULL,
	`content` blob NOT NULL,
	CONSTRAINT `skill_resources_pk` PRIMARY KEY(`skill_id`, `path`),
	CONSTRAINT `fk_skill_resources_skill_id_skills_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skills` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`description` text NOT NULL,
	`content` text NOT NULL,
	`source_url` text,
	`bundled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "skills_bundled_check" CHECK("bundled" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_checkpoints` (
	`task_id` text PRIMARY KEY,
	`messages_json` text DEFAULT '[]' NOT NULL,
	`pending_tool_json` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_task_checkpoints_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_image_attachments` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`coworker_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`relative_path` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_task_image_attachments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_image_attachments_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT "task_image_attachments_size_check" CHECK("size" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY,
	`coworker_id` text NOT NULL,
	`schedule_id` text,
	`run_id` text,
	`thread_id` text,
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
	CONSTRAINT "tasks_status_check" CHECK("status" in ('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "tasks_source_check" CHECK("source" in ('manual', 'schedule', 'recovery'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tool_calls` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`coworker_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`arguments_json` text,
	`result_json` text,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL UNIQUE,
	`created_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT `fk_tool_calls_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tool_calls_coworker_id_coworkers_id_fk` FOREIGN KEY (`coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT "tool_calls_status_check" CHECK("status" in ('REQUESTED', 'WAITING_FOR_APPROVAL', 'RUNNING', 'COMPLETED', 'FAILED', 'DENIED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `activity_created_idx` ON `activity` ("created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `approvals_status_created_idx` ON `approvals` (`status`,"created_at" asc);--> statement-breakpoint
DELETE FROM `artifacts`
WHERE `task_id` IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM `artifacts`
    WHERE `task_id` IS NOT NULL
    GROUP BY `task_id`, `file_path`
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `artifacts_task_path_idx` ON `artifacts` (`task_id`,`file_path`) WHERE "artifacts"."task_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `conversations_coworker_updated_idx` ON `conversations` (`coworker_id`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_coworker_created_idx` ON `messages` (`coworker_id`,"created_at" asc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `task_image_attachments_task_idx` ON `task_image_attachments` (`task_id`,"created_at" asc);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tasks_run_id_idx` ON `tasks` (`run_id`) WHERE "tasks"."run_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_coworker_queue_idx` ON `tasks` (`coworker_id`,`status`,"priority" desc,"created_at" asc);--> statement-breakpoint
INSERT OR IGNORE INTO `conversations` (`id`, `coworker_id`, `title`, `created_at`, `updated_at`)
SELECT
  `tasks`.`thread_id`,
  `tasks`.`coworker_id`,
  MIN(`tasks`.`title`),
  MIN(`tasks`.`created_at`),
  MAX(COALESCE(`tasks`.`completed_at`, `tasks`.`started_at`, `tasks`.`created_at`))
FROM `tasks`
WHERE `tasks`.`thread_id` IS NOT NULL AND `tasks`.`thread_id` <> ''
GROUP BY `tasks`.`thread_id`, `tasks`.`coworker_id`;--> statement-breakpoint
INSERT OR IGNORE INTO `conversations` (`id`, `coworker_id`, `title`, `created_at`, `updated_at`)
SELECT
  'coworker:' || `coworkers`.`id`,
  `coworkers`.`id`,
  'New conversation',
  `coworkers`.`created_at`,
  `coworkers`.`updated_at`
FROM `coworkers`
WHERE NOT EXISTS (
  SELECT 1 FROM `conversations`
  WHERE `conversations`.`coworker_id` = `coworkers`.`id`
);--> statement-breakpoint
INSERT OR IGNORE INTO `schema_migrations` (`version`, `applied_at`)
VALUES (1, datetime('now'));