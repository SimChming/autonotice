CREATE TABLE `admin_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer,
	`action` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admins_username_unique` ON `admins` (`username`);--> statement-breakpoint
CREATE TABLE `agent_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`action` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`result` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`schedule_id` integer,
	`level` text DEFAULT 'normal' NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`route` text DEFAULT 'ws' NOT NULL,
	`at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bind_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`qq` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`qq` text NOT NULL,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bindings_qq_unique` ON `bindings` (`qq`);--> statement-breakpoint
CREATE TABLE `bot_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`role` text NOT NULL,
	`sender_qq` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_summary` (
	`session_key` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`covered_id` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_hash` text NOT NULL,
	`source_url` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_assets_content_hash_unique` ON `content_assets` (`content_hash`);--> statement-breakpoint
CREATE TABLE `doc_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`path` text NOT NULL,
	`quota_date` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`group_id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`avatar` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`sender_qq` text,
	`content` text NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`embedding` text DEFAULT '[]' NOT NULL,
	`kind` text DEFAULT 'chat' NOT NULL,
	`scope` text DEFAULT 'peer' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`sender_qq` text NOT NULL,
	`text` text NOT NULL,
	`raw_json` text NOT NULL,
	`msg_time` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`group_id` text,
	`title` text NOT NULL,
	`type` text DEFAULT 'task' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` integer,
	`remind_at` integer,
	`notes` text DEFAULT '' NOT NULL,
	`source_msg_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);