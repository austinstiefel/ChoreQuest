-- Definitions read from sqlite_master in the legacy database; no user data.
CREATE TABLE users (
 id INTEGER NOT NULL,
 username VARCHAR(50) NOT NULL,
 display_name VARCHAR(10) NOT NULL,
 password_hash VARCHAR NOT NULL,
 pin_hash VARCHAR,
 role VARCHAR(6) NOT NULL,
 points_balance INTEGER NOT NULL,
 total_points_earned INTEGER NOT NULL,
 current_streak INTEGER NOT NULL,
 longest_streak INTEGER NOT NULL,
 last_streak_date DATE,
 streak_freezes_used INTEGER NOT NULL,
 streak_freeze_month INTEGER,
 avatar_config JSON,
 is_active BOOLEAN NOT NULL,
 created_at DATETIME NOT NULL,
 updated_at DATETIME NOT NULL,
 PRIMARY KEY (id),
 UNIQUE (username)
);
CREATE TABLE chores (
 id INTEGER NOT NULL, title VARCHAR(200) NOT NULL, description TEXT,
 points INTEGER NOT NULL, difficulty VARCHAR(6) NOT NULL, icon VARCHAR(50),
 category_id INTEGER NOT NULL, recurrence VARCHAR(11) NOT NULL, custom_days JSON,
 requires_photo BOOLEAN NOT NULL, is_active BOOLEAN NOT NULL, created_by INTEGER NOT NULL,
 created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
 PRIMARY KEY (id), FOREIGN KEY(category_id) REFERENCES chore_categories (id),
 FOREIGN KEY(created_by) REFERENCES users (id)
);
CREATE TABLE rewards (
 id INTEGER NOT NULL, title VARCHAR(200) NOT NULL, description TEXT, point_cost INTEGER NOT NULL,
 icon VARCHAR(50), category VARCHAR(50), stock INTEGER, auto_approve_threshold INTEGER,
 is_active BOOLEAN NOT NULL, created_by INTEGER NOT NULL, created_at DATETIME NOT NULL,
 updated_at DATETIME NOT NULL, PRIMARY KEY (id), FOREIGN KEY(created_by) REFERENCES users (id)
);
CREATE TABLE seasonal_events (
 id INTEGER NOT NULL, title VARCHAR(200) NOT NULL, description TEXT, multiplier FLOAT NOT NULL,
 start_date DATETIME NOT NULL, end_date DATETIME NOT NULL, is_active BOOLEAN NOT NULL,
 created_by INTEGER NOT NULL, created_at DATETIME NOT NULL,
 PRIMARY KEY (id), FOREIGN KEY(created_by) REFERENCES users (id)
);
CREATE TABLE api_keys (
 id INTEGER NOT NULL, name VARCHAR(100) NOT NULL, key_hash VARCHAR NOT NULL,
 key_prefix VARCHAR(8) NOT NULL, scopes JSON NOT NULL, created_by INTEGER NOT NULL,
 last_used_at DATETIME, is_active BOOLEAN NOT NULL, created_at DATETIME NOT NULL,
 PRIMARY KEY (id), FOREIGN KEY(created_by) REFERENCES users (id)
);
CREATE TABLE invite_codes (
 id INTEGER NOT NULL, code VARCHAR(20) NOT NULL, role VARCHAR(6) NOT NULL,
 max_uses INTEGER NOT NULL, times_used INTEGER NOT NULL, created_by INTEGER NOT NULL,
 expires_at DATETIME, created_at DATETIME NOT NULL, PRIMARY KEY (id), UNIQUE (code),
 FOREIGN KEY(created_by) REFERENCES users (id)
);
CREATE TABLE shoutouts (
 id INTEGER NOT NULL, from_user_id INTEGER NOT NULL, to_user_id INTEGER NOT NULL,
 message VARCHAR(200) NOT NULL, emoji VARCHAR(10) NOT NULL, created_at DATETIME NOT NULL,
 PRIMARY KEY (id), FOREIGN KEY(from_user_id) REFERENCES users (id),
 FOREIGN KEY(to_user_id) REFERENCES users (id)
);
CREATE TABLE announcements (
 id INTEGER NOT NULL, title VARCHAR(200) NOT NULL, message TEXT NOT NULL, icon VARCHAR(50),
 is_pinned BOOLEAN NOT NULL, created_by INTEGER NOT NULL, created_at DATETIME NOT NULL,
 PRIMARY KEY (id), FOREIGN KEY(created_by) REFERENCES users (id)
);
CREATE TABLE vacation_periods (
 id INTEGER NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL,
 created_by INTEGER NOT NULL, is_active BOOLEAN NOT NULL, created_at DATETIME NOT NULL,
 PRIMARY KEY (id), FOREIGN KEY(created_by) REFERENCES users (id)
);
