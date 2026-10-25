-- Creation and lookup may expose different identifiers for the same external_id.
-- Preserve the creation ID and bind the lookup ID only after validating reference/value.
ALTER TABLE "ZettpayPayment" ADD COLUMN "lookupProviderId" VARCHAR(160);
CREATE UNIQUE INDEX "ZettpayPayment_lookupProviderId_key" ON "ZettpayPayment"("lookupProviderId");
