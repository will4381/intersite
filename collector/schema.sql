-- Intersite collector schema. Idempotent: safe to apply on every deploy.
-- Every index costs one extra row written per insert (D1 bills rows written), so each one is here for a named query.

CREATE TABLE IF NOT EXISTS cases (
  project TEXT NOT NULL,
  id      TEXT NOT NULL,
  session TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at_ms   INTEGER NOT NULL,          -- Date.parse(case.at)
  outcome TEXT NOT NULL,
  route   TEXT NOT NULL,
  expires INTEGER NOT NULL,          -- at_ms + ttlDays, epoch ms
  pinned  INTEGER NOT NULL DEFAULT 0,
  body    TEXT NOT NULL,             -- the whole Case as JSON
  PRIMARY KEY (project, id)          -- duplicate check on ingest, GET /v1/cases/:id, pin
);

-- GET /v1/sessions candidates with no filter or only `since`: newest cases of a project.
CREATE INDEX IF NOT EXISTS cases_by_time ON cases (project, at_ms);
-- GET /v1/sessions?outcome=: newest cases of a project with that outcome.
CREATE INDEX IF NOT EXISTS cases_by_outcome ON cases (project, outcome, at_ms);
-- GET /v1/sessions?route=: newest cases of a project on that route.
CREATE INDEX IF NOT EXISTS cases_by_route ON cases (project, route, at_ms);
-- Loading the sampled sessions' cases in seq order; earlier cases for GET /v1/cases/:id; cleanup of orphaned results.
CREATE INDEX IF NOT EXISTS cases_by_session ON cases (project, session, seq);
-- Cleanup: expired cases that are not pinned. Partial, so pinned cases cost nothing here.
CREATE INDEX IF NOT EXISTS cases_by_expiry ON cases (expires) WHERE pinned = 0;

-- Cases stored per project, UTC day and outcome class ("ok" or "other"). Enforces the daily cap without a COUNT scan.
CREATE TABLE IF NOT EXISTS daily_counts (
  project TEXT NOT NULL,
  day     TEXT NOT NULL,             -- YYYY-MM-DD
  class   TEXT NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (project, day, class)
) WITHOUT ROWID;

-- Latest replay result per session; known_good=1 reads it, POST /v1/results overwrites it.
CREATE TABLE IF NOT EXISTS results (
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  release TEXT NOT NULL,
  pass    INTEGER NOT NULL,
  at_ms   INTEGER NOT NULL,
  PRIMARY KEY (project, session)
) WITHOUT ROWID;
