-- Read-only preflight. No automatic deletion or renumbering.
SELECT t."campaignId", n.value AS number, array_agg(t.serial ORDER BY t.serial) AS tickets, count(*) AS occurrences
FROM "TicketNumber" n JOIN "Ticket" t ON t.id = n."ticketId"
GROUP BY t."campaignId", n.value HAVING count(*) > 1;
SELECT t."campaignId", t.serial, count(n.id) AS numbers
FROM "Ticket" t LEFT JOIN "TicketNumber" n ON n."ticketId" = t.id GROUP BY t.id HAVING count(n.id) <> 4;
SELECT * FROM "TicketNumber" WHERE value !~ '^[0-9]{4}$' OR position NOT BETWEEN 1 AND 4;
SELECT "campaignId", count(*) FROM "Ticket" GROUP BY "campaignId" HAVING count(*) > 2500;
