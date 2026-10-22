CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`handler` text,
	`permissions` text DEFAULT 'all' NOT NULL,
	`params_schema` text DEFAULT '{}' NOT NULL,
	`version` text DEFAULT '1.0.0' NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
