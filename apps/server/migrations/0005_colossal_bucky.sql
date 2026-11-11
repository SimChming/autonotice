CREATE TABLE `soul_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `soul_journals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`mood` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `soul_journals_day_idx` ON `soul_journals` (`day`);--> statement-breakpoint
CREATE TABLE `soul_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `soul_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`mood` text DEFAULT '平静' NOT NULL,
	`mood_intensity` integer DEFAULT 50 NOT NULL,
	`energy` integer DEFAULT 80 NOT NULL,
	`traits` text DEFAULT '{}' NOT NULL,
	`last_wake_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `soul_visits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`viewer_qq` text NOT NULL,
	`at` integer NOT NULL,
	`told_at` integer
);
