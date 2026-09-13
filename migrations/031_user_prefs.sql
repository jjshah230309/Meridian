-- =====================================================================
-- Meridian ERP :: 031_user_prefs
--
-- The desktop app deliberately starts its server on a random port every
-- launch, so two open companies never fight over one port (see
-- native/macos/main.swift) -- which means the browser's own storage is
-- useless for anything that has to survive a restart: it is scoped to an
-- origin that is different every time. A few things genuinely need to
-- survive one anyway, starting with whether this person has already been
-- shown the welcome tour. The account itself is the one thing that stays
-- the same across launches, so that is where those settle instead.
-- =====================================================================

ALTER TABLE app_user ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
