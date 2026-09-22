ALTER TABLE "devices" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "installation_id" varchar(100);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "platform_version" varchar(50);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "model" varchar(100);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app_version" varchar(50);--> statement-breakpoint
CREATE UNIQUE INDEX "devices_installation_id_idx" ON "devices" USING btree ("installation_id");