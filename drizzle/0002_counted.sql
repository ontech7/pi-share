ALTER TABLE `events` ADD `counted` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `events` SET `counted` = 1 WHERE `type` = 'download_finished';
