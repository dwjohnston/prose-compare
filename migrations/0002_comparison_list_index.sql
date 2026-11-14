-- Newest-first listing for the "All results" page.
CREATE INDEX comparison_created ON comparison(created_at DESC, id DESC);
