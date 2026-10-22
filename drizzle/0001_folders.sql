CREATE TABLE `folder_snapshots` (
	`link_id` text NOT NULL,
	`position` integer NOT NULL,
	`relative` text NOT NULL,
	`size` integer NOT NULL,
	`modified_at` integer NOT NULL,
	PRIMARY KEY(`link_id`, `position`, `relative`),
	FOREIGN KEY (`link_id`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `events` ADD `path` text;--> statement-breakpoint
ALTER TABLE `link_files` ADD `kind` text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE `links` ADD `on_change` text DEFAULT 'pause' NOT NULL;