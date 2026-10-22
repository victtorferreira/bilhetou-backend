require('dotenv/config');
const { Client } = require('pg');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const client = new Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await client.connect();
  const results = await client.query(readFileSync(join(__dirname, 'audit-ticket-numbers.sql'), 'utf8'));
  const labels = ['duplicateNumbers', 'invalidTicketCardinality', 'invalidNumbersOrPositions', 'campaignsAboveCapacity'];
  const report = Object.fromEntries(results.map((result, index) => [labels[index], result.rows]));
  console.log(JSON.stringify(report, null, 2));
  if (results.some(result => result.rows.length)) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => client.end());
