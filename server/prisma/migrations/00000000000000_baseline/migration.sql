-- CreateTable
CREATE TABLE "achievements" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "points_reward" INTEGER NOT NULL,
    "criteria" json NOT NULL,
    "tier" TEXT,
    "group_key" TEXT,
    "sort_order" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "icon" TEXT,
    "is_pinned" BOOLEAN NOT NULL,
    "created_by" INTEGER,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "scopes" json NOT NULL,
    "created_by" INTEGER,
    "last_used_at" DATETIME,
    "is_active" BOOLEAN NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "details" json,
    "ip_address" TEXT,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "avatar_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "category" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "unlock_method" TEXT NOT NULL,
    "unlock_value" INTEGER,
    "is_default" BOOLEAN NOT NULL,
    "created_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "chore_assignment_rules" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chore_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "recurrence" TEXT NOT NULL,
    "custom_days" json,
    "requires_photo" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "created_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "chore_assignment_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "chore_assignment_rules_chore_id_fkey" FOREIGN KEY ("chore_id") REFERENCES "chores" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "chore_assignments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chore_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "date" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "completed_at" DATETIME,
    "verified_at" DATETIME,
    "verified_by" INTEGER,
    "photo_proof_path" TEXT,
    "feedback" TEXT,
    "created_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "chore_assignments_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "chore_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "chore_assignments_chore_id_fkey" FOREIGN KEY ("chore_id") REFERENCES "chores" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "chore_categories" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL,
    "created_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "chore_exclusions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chore_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "date" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "chore_exclusions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "chore_exclusions_chore_id_fkey" FOREIGN KEY ("chore_id") REFERENCES "chores" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "chore_rotations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chore_id" INTEGER NOT NULL,
    "kid_ids" json NOT NULL,
    "cadence" TEXT NOT NULL,
    "current_index" INTEGER NOT NULL,
    "last_rotated" DATETIME,
    "created_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "chore_rotations_chore_id_fkey" FOREIGN KEY ("chore_id") REFERENCES "chores" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "chores" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "points" INTEGER NOT NULL,
    "difficulty" TEXT NOT NULL,
    "icon" TEXT,
    "category_id" INTEGER NOT NULL,
    "recurrence" TEXT NOT NULL,
    "custom_days" json,
    "requires_photo" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "created_by" INTEGER,
    "created_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "chores_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "chores_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "chore_categories" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "invite_codes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "max_uses" INTEGER NOT NULL,
    "times_used" INTEGER NOT NULL,
    "created_by" INTEGER,
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "invite_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL,
    "reference_type" TEXT,
    "reference_id" INTEGER,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "point_transactions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reference_id" INTEGER,
    "created_by" INTEGER,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "point_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "point_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "quest_templates" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "suggested_points" INTEGER NOT NULL,
    "difficulty" TEXT NOT NULL,
    "category_name" TEXT NOT NULL,
    "icon" TEXT
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "is_revoked" BOOLEAN NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "reward_redemptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "reward_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "points_spent" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "approved_by" INTEGER,
    "approved_at" DATETIME,
    "fulfilled_by" INTEGER,
    "fulfilled_at" DATETIME,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "reward_redemptions_fulfilled_by_fkey" FOREIGN KEY ("fulfilled_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "reward_redemptions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "reward_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "reward_redemptions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "rewards" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "point_cost" INTEGER NOT NULL,
    "icon" TEXT,
    "category" TEXT,
    "stock" INTEGER,
    "auto_approve_threshold" INTEGER,
    "is_active" BOOLEAN NOT NULL,
    "created_by" INTEGER,
    "created_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "rewards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "seasonal_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "multiplier" REAL NOT NULL,
    "start_date" DATETIME NOT NULL,
    "end_date" DATETIME NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "created_by" INTEGER,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "seasonal_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "shoutouts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "from_user_id" INTEGER,
    "to_user_id" INTEGER,
    "message" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "shoutouts_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "shoutouts_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "spin_results" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "points_won" INTEGER NOT NULL,
    "spin_date" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "spin_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "user_achievements" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "achievement_id" INTEGER NOT NULL,
    "unlocked_at" DATETIME NOT NULL,
    CONSTRAINT "user_achievements_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievements" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "user_achievements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "user_avatar_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "avatar_item_id" INTEGER NOT NULL,
    "acquired_via" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "user_avatar_items_avatar_item_id_fkey" FOREIGN KEY ("avatar_item_id") REFERENCES "avatar_items" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "user_avatar_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "pin_hash" TEXT,
    "role" TEXT NOT NULL,
    "points_balance" INTEGER NOT NULL,
    "total_points_earned" INTEGER NOT NULL,
    "current_streak" INTEGER NOT NULL,
    "longest_streak" INTEGER NOT NULL,
    "last_streak_date" DATETIME,
    "streak_freezes_used" INTEGER NOT NULL,
    "streak_freeze_month" INTEGER,
    "avatar_config" json,
    "is_active" BOOLEAN NOT NULL,
    "created_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "vacation_periods" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "start_date" DATETIME NOT NULL,
    "end_date" DATETIME NOT NULL,
    "created_by" INTEGER,
    "is_active" BOOLEAN NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "vacation_periods_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "image_url" TEXT,
    "notes" TEXT,
    "converted_to_reward_id" INTEGER,
    "created_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "wishlist_items_converted_to_reward_id_fkey" FOREIGN KEY ("converted_to_reward_id") REFERENCES "rewards" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "wishlist_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateIndex
CREATE UNIQUE INDEX "achievements_key_key" ON "achievements"("key");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_items_category_item_id_key" ON "avatar_items"("category", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "chore_assignment_rules_chore_id_user_id_key" ON "chore_assignment_rules"("chore_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chore_assignments_chore_id_user_id_date_key" ON "chore_assignments"("chore_id", "user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "chore_exclusions_chore_id_user_id_date_key" ON "chore_exclusions"("chore_id", "user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "invite_codes_code_key" ON "invite_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_user_id_endpoint_key" ON "push_subscriptions"("user_id", "endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "spin_results_user_id_spin_date_key" ON "spin_results"("user_id", "spin_date");

-- CreateIndex
CREATE UNIQUE INDEX "user_achievements_user_id_achievement_id_key" ON "user_achievements"("user_id", "achievement_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_avatar_items_user_id_avatar_item_id_key" ON "user_avatar_items"("user_id", "avatar_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");


