CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  provider      text NOT NULL,
  email         text NOT NULL,
  access_token  text NOT NULL,
  refresh_token text,
  expires_at    timestamptz,
  scope         text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (provider, email)
);

ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;

-- Service role can read/write; anon cannot touch tokens
CREATE POLICY "service role full access" ON oauth_tokens
  TO service_role
  USING (true)
  WITH CHECK (true);
