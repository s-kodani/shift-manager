-- Better Auth 1.7.7 native D1 schema; admin plugin for server-side provisioning.
CREATE TABLE "user" ("id" TEXT PRIMARY KEY NOT NULL,
"name" TEXT NOT NULL,
"email" TEXT NOT NULL UNIQUE,
"emailVerified" INTEGER NOT NULL DEFAULT 0,
"image" TEXT,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL,
"role" TEXT,
"banned" INTEGER DEFAULT 0,
"banReason" TEXT,
"banExpires" INTEGER);
CREATE TABLE "session" ("id" TEXT PRIMARY KEY NOT NULL,
"expiresAt" INTEGER NOT NULL,
"token" TEXT NOT NULL UNIQUE,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL,
"ipAddress" TEXT,
"userAgent" TEXT,
"userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
"impersonatedBy" TEXT);
CREATE INDEX "session_userId" ON "session"("userId");
CREATE TABLE "account" ("id" TEXT PRIMARY KEY NOT NULL,
"accountId" TEXT NOT NULL,
"providerId" TEXT NOT NULL,
"userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
"accessToken" TEXT,
"refreshToken" TEXT,
"idToken" TEXT,
"accessTokenExpiresAt" INTEGER,
"refreshTokenExpiresAt" INTEGER,
"scope" TEXT,
"password" TEXT,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL);
CREATE INDEX "account_userId" ON "account"("userId");
CREATE TABLE "verification" ("id" TEXT PRIMARY KEY NOT NULL,
"identifier" TEXT NOT NULL,
"value" TEXT NOT NULL,
"expiresAt" INTEGER NOT NULL,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL);
CREATE INDEX "verification_identifier" ON "verification"("identifier");
