DROP INDEX IF EXISTS "provider_oauth_ownerships_accountName_key";

CREATE UNIQUE INDEX IF NOT EXISTS "provider_oauth_ownerships_provider_accountName_key"
ON "provider_oauth_ownerships"("provider", "accountName");
