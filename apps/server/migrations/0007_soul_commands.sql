CREATE TABLE `soul_commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command` text NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`ok` integer DEFAULT 1 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`trigger` text DEFAULT 'self' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL
);
