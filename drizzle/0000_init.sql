CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`link_id` text NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`file` integer,
	`download_id` text,
	`ip` text,
	`country` text,
	`user_agent` text,
	`language` text,
	`visitor` text,
	`bytes` integer,
	`detail` text,
	FOREIGN KEY (`link_id`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_link_at` ON `events` (`link_id`,`at`);--> statement-breakpoint
CREATE TABLE `link_files` (
	`link_id` text NOT NULL,
	`position` integer NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`modified_at` integer NOT NULL,
	PRIMARY KEY(`link_id`, `position`),
	FOREIGN KEY (`link_id`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`sealed_key` text NOT NULL,
	`password_hash` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`max_downloads` integer,
	`active` integer DEFAULT true NOT NULL,
	`locked_at` integer,
	`failed_passwords` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
