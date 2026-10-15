-- Daily cap on LLM drafting. Workers AI's free allocation (10,000 neurons per
-- UTC day) is shared by every app on the account, so a provider other than the
-- stub claims one draft here before each call (LLM_DAILY_DRAFT_LIMIT) and falls
-- back to the template once the day's drafts are used up.
CREATE TABLE llm_daily_usage (
  day TEXT PRIMARY KEY,                      -- UTC date, YYYY-MM-DD
  drafts INTEGER NOT NULL DEFAULT 0 CHECK (drafts >= 0)
);
