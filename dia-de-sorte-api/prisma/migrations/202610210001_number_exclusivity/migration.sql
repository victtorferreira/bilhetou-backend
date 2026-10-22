BEGIN;
LOCK TABLE "Ticket", "TicketNumber" IN ACCESS EXCLUSIVE MODE;

-- Fail without modifying existing data. Run scripts/audit-ticket-numbers.sql first.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "TicketNumber" n JOIN "Ticket" t ON t.id = n."ticketId"
             GROUP BY t."campaignId", n.value HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Números duplicados. Execute scripts/audit-ticket-numbers.sql; resolva os conflitos manualmente.';
  END IF;
  IF EXISTS (SELECT 1 FROM "TicketNumber" WHERE value !~ '^[0-9]{4}$' OR position NOT BETWEEN 1 AND 4)
     OR EXISTS (SELECT 1 FROM "Ticket" t LEFT JOIN "TicketNumber" n ON n."ticketId" = t.id GROUP BY t.id HAVING count(n.id) <> 4)
     OR EXISTS (SELECT 1 FROM "Ticket" GROUP BY "campaignId" HAVING count(*) > 2500) THEN
    RAISE EXCEPTION 'Estoque inválido. Execute scripts/audit-ticket-numbers.sql antes da migração.';
  END IF;
END $$;

ALTER TABLE "TicketNumber" ADD COLUMN "campaignId" UUID;
UPDATE "TicketNumber" n SET "campaignId" = t."campaignId" FROM "Ticket" t WHERE t.id = n."ticketId";
ALTER TABLE "TicketNumber" ALTER COLUMN "campaignId" SET NOT NULL;
CREATE UNIQUE INDEX "Ticket_id_campaignId_key" ON "Ticket" (id, "campaignId");
ALTER TABLE "TicketNumber" DROP CONSTRAINT "TicketNumber_ticketId_fkey";
ALTER TABLE "TicketNumber" ADD CONSTRAINT "TicketNumber_ticketId_campaignId_fkey"
  FOREIGN KEY ("ticketId", "campaignId") REFERENCES "Ticket" (id, "campaignId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "TicketNumber_campaignId_value_key" ON "TicketNumber" ("campaignId", value);
CREATE UNIQUE INDEX "TicketNumber_ticketId_value_key" ON "TicketNumber" ("ticketId", value);
ALTER TABLE "TicketNumber" ADD CONSTRAINT "TicketNumber_value_check" CHECK (value ~ '^[0-9]{4}$');
ALTER TABLE "TicketNumber" ADD CONSTRAINT "TicketNumber_position_check" CHECK (position BETWEEN 1 AND 4);

-- Deferred constraint allows nested creates/createMany inside one transaction,
-- but a transaction can never commit a ticket with fewer/more than four numbers.
CREATE FUNCTION bilhetou_four_numbers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid;
BEGIN
  IF TG_TABLE_NAME = 'Ticket' THEN
    tid := NEW.id;
  ELSE
    IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM "Ticket" WHERE id = OLD."ticketId")
       AND (SELECT count(*) FROM "TicketNumber" WHERE "ticketId" = OLD."ticketId") <> 4 THEN
      RAISE EXCEPTION 'O bilhete deve ter exatamente quatro números' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    tid := NEW."ticketId";
  END IF;
  IF EXISTS (SELECT 1 FROM "Ticket" WHERE id = tid)
     AND (SELECT count(*) FROM "TicketNumber" WHERE "ticketId" = tid) <> 4 THEN
    RAISE EXCEPTION 'O bilhete deve ter exatamente quatro números' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ticket_four_numbers AFTER INSERT OR UPDATE ON "Ticket"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bilhetou_four_numbers();
CREATE CONSTRAINT TRIGGER number_four_numbers AFTER INSERT OR UPDATE OR DELETE ON "TicketNumber"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bilhetou_four_numbers();

CREATE FUNCTION bilhetou_protect_numbers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Lock the parent before checking its state; concurrent assignment must wait.
  IF TG_OP = 'INSERT' THEN
    PERFORM id FROM "Ticket" WHERE id = NEW."ticketId" FOR UPDATE;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM id FROM "Ticket" WHERE id = OLD."ticketId" FOR UPDATE;
  ELSE
    PERFORM id FROM "Ticket" WHERE id IN (OLD."ticketId", NEW."ticketId") ORDER BY id FOR UPDATE;
  END IF;
  IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM "Ticket" WHERE id = OLD."ticketId" AND (status <> 'AVAILABLE' OR "assignedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Não é permitido alterar números de um bilhete atribuído ou cancelado' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM "Ticket" WHERE id = NEW."ticketId" AND (status <> 'AVAILABLE' OR "assignedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Não é permitido alterar números de um bilhete atribuído ou cancelado' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_ticket_numbers BEFORE INSERT OR UPDATE OR DELETE ON "TicketNumber"
  FOR EACH ROW EXECUTE FUNCTION bilhetou_protect_numbers();

CREATE TABLE "DrawCheck" (
  id UUID NOT NULL PRIMARY KEY, "campaignId" UUID NOT NULL,
  reference TEXT NOT NULL, number VARCHAR(4) NOT NULL CHECK (number ~ '^[0-9]{4}$'),
  actor TEXT NOT NULL, snapshot JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DrawCheck_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" (id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DrawCheck_campaignId_reference_key" ON "DrawCheck" ("campaignId", reference);
CREATE INDEX "DrawCheck_campaignId_createdAt_idx" ON "DrawCheck" ("campaignId", "createdAt");
CREATE FUNCTION bilhetou_immutable_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'O histórico de conferências é imutável' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER immutable_draw_check BEFORE UPDATE OR DELETE ON "DrawCheck"
  FOR EACH ROW EXECUTE FUNCTION bilhetou_immutable_check();
COMMIT;
