CREATE TABLE `triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`session_key` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer,
	`event` text,
	`action` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
