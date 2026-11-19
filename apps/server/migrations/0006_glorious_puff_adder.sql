CREATE TABLE `soul_drives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`level` integer DEFAULT 50 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `soul_drives_name_idx` ON `soul_drives` (`name`);--> statement-breakpoint
CREATE TABLE `soul_intentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`kind` text DEFAULT 'goal' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`progress` text DEFAULT '' NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `soul_reflections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text NOT NULL,
	`importance` integer DEFAULT 50 NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL
);
