CREATE TABLE `agent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`session_key` text,
	`addressed` integer DEFAULT 0 NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`importance` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `agent_events_created_idx` ON `agent_events` (`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'condition' NOT NULL,
	`session_key` text,
	`condition` text DEFAULT '{}' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`one_shot` integer DEFAULT 0 NOT NULL,
	`cooldown_ms` integer DEFAULT 300000 NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`expires_at` integer,
	`last_checked_at` integer,
	`last_fired_at` integer,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_triggers_enabled_idx` ON `agent_triggers` (`enabled`);
--> statement-breakpoint
CREATE TABLE `agent_activations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text,
	`mode` text DEFAULT 'free' NOT NULL,
	`kind` text NOT NULL,
	`trigger_id` integer,
	`event_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`task` text DEFAULT '' NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`next_run_at` integer,
	`lease_until` integer,
	`continue_count` integer DEFAULT 0 NOT NULL,
	`max_continues` integer DEFAULT 40 NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	`last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_activations_ready_idx` ON `agent_activations` (`status`, `next_run_at`);
--> statement-breakpoint
CREATE INDEX `agent_activations_session_idx` ON `agent_activations` (`session_key`);
--> statement-breakpoint
CREATE TABLE `agent_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activation_id` integer,
	`event_id` integer,
	`classifier` text DEFAULT '{}' NOT NULL,
	`thought` text DEFAULT '' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_cycles_created_idx` ON `agent_cycles` (`created_at`);
