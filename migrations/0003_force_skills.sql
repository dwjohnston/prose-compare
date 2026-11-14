-- "Force all skills": each lane's prompt tells the model to load every skill in that lane first.
ALTER TABLE comparison ADD COLUMN force_skills INTEGER NOT NULL DEFAULT 0;
