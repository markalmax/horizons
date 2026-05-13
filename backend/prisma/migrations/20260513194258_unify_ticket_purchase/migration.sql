/*
  Warnings:

  - You are about to drop the column `rsvp_enabled` on the `events` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "events" DROP COLUMN "rsvp_enabled";

-- CreateIndex
CREATE INDEX "users_streak_leaderboard_idx" ON "users"("current_streak" DESC, "last_active_date" DESC, "user_id");
