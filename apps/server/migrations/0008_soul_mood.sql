ALTER TABLE `soul_state` ADD `mood_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `soul_state` SET `mood_at` = `updated_at` WHERE `mood_at` = 0;
