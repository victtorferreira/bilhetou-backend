// Explicit, operator-run migration. Never runs during application startup.
const { Client } = require('pg');
const { spawnSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
require('dotenv').config({ path: join(__dirname, '..', '.env.migration'), quiet: true });

class MigrationError extends Error {}

function databaseUrl(value) {
  if (!value) throw new MigrationError('Preencha as duas URLs no arquivo local .env.migration.');
  let url;
  try { url = new URL(value); } catch { throw new MigrationError('URL PostgreSQL inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new MigrationError('URL PostgreSQL inválida.');
  return url;
}
function assertDifferent(source, target) {
  if (source.hostname === target.hostname && (source.port || '5432') === (target.port || '5432') && source.pathname === target.pathname) {
    throw new MigrationError('Origem e destino apontam para o mesmo banco. Operação recusada.');
  }
}
function pgEnvironment(url) {
  // Credentials travel through the child environment, never command-line arguments.
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: url.searchParams.get('sslmode') || 'prefer', PGAPPNAME: 'bilhetou-migration' };
  for (const [key, variable] of [['sslrootcert', 'PGSSLROOTCERT'], ['sslcert', 'PGSSLCERT'], ['sslkey', 'PGSSLKEY']]) {
    if (url.searchParams.has(key)) env[variable] = url.searchParams.get(key);
  }
  return env;
}
function pgCommand(command, args, url) {
  const result = spawnSync(command, args, { env: pgEnvironment(url), encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new MigrationError(`${command} falhou. Confira instalação do cliente PostgreSQL, versões e acesso ao banco. Nenhuma credencial foi exibida.`);
}
const quote = value => `"${value.replace(/"/g, '""')}"`;

async function withClient(url, action) {
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000, application_name: 'bilhetou-migration' });
  try { await client.connect(); return await action(client); } finally { await client.end(); }
}
async function tables(client) {
  return (await client.query(`SELECT schemaname AS schema, tablename AS name FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname !~ '^pg_toast'
    ORDER BY schemaname, tablename`)).rows;
}
async function assertEmpty(client) {
  if ((await tables(client)).length) throw new MigrationError('O destino já possui tabelas. Use um banco novo e vazio; nenhuma tabela será apagada automaticamente.');
}
async function fingerprint(url) {
  return withClient(url, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const version = (await client.query('SHOW server_version')).rows[0].server_version;
    const result = { version, tables: [], columns: [], indexes: [], constraints: [], triggers: [], functions: [], sequences: [] };
    for (const table of await tables(client)) {
      const qualified = `${quote(table.schema)}.${quote(table.name)}`;
      const { rows } = await client.query(`SELECT count(*)::text AS count,
        md5(coalesce(string_agg(row_hash, '' ORDER BY row_hash COLLATE "C"), '')) AS digest
        FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM ${qualified} t) hashes`);
      result.tables.push({ ...table, ...rows[0] });
    }
    result.columns = (await client.query(`SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name,
      a.attnum AS position, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
      pg_get_expr(d.adbin, d.adrelid) AS "default" FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`)).rows;
    result.indexes = (await client.query(`SELECT schemaname AS schema, tablename AS "table", indexname AS name,
      indexdef AS definition FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`)).rows;
    result.constraints = (await client.query(`SELECT n.nspname AS schema, c.relname AS "table", k.conname AS name,
      pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' ORDER BY n.nspname, c.relname, k.conname`)).rows;
    result.triggers = (await client.query(`SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name,
      t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`)).rows;
    result.functions = (await client.query(`SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'bilhetou_%' ORDER BY p.proname, p.oid`)).rows;
    const sequences = (await client.query("SELECT sequence_schema AS schema, sequence_name AS name FROM information_schema.sequences WHERE sequence_schema = 'public' ORDER BY sequence_name")).rows;
    for (const sequence of sequences) {
      const state = (await client.query(`SELECT last_value::text, is_called FROM ${quote(sequence.schema)}.${quote(sequence.name)}`)).rows[0];
      result.sequences.push({ ...sequence, ...state });
    }
    await client.query('COMMIT');
    return result;
  });
}
function sameFingerprint(source, target) {
  const content = value => JSON.stringify({ tables: value.tables, columns: value.columns, indexes: value.indexes, constraints: value.constraints,
    triggers: value.triggers, functions: value.functions, sequences: value.sequences });
  return content(source) === content(target);
}
function fileHash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

async function main() {
  const action = process.argv[2];
  if (!['backup', 'restore', 'verify'].includes(action)) throw new MigrationError('Uso: node scripts/migrate-render-railway.cjs backup|restore|verify [arquivo.dump]');
  const source = databaseUrl(process.env.MIGRATION_SOURCE_URL);
  const target = databaseUrl(process.env.MIGRATION_TARGET_URL);
  assertDifferent(source, target);
  if (action === 'backup' && !process.argv.includes('--writes-paused')) throw new MigrationError('Pause todos os escritores no Render e execute backup --writes-paused.');
  if (action === 'restore' && !process.argv.includes('--target-empty')) throw new MigrationError('Confirme o destino vazio com restore arquivo.dump --target-empty.');
  const folder = resolve(__dirname, '..', 'backups');
  const argument = process.argv.slice(3).find(value => !value.startsWith('--'));
  const path = argument ? resolve(argument) : join(folder, `render-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  if (action === 'backup') {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (existsSync(path)) throw new MigrationError('O arquivo de backup já existe. Escolha outro nome.');
    const before = await fingerprint(source);
    pgCommand('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', path], source);
    const after = await fingerprint(source);
    if (!sameFingerprint(before, after)) throw new MigrationError('A origem mudou durante o backup. Pause todos os escritores e gere outro backup antes de restaurar.');
    writeFileSync(`${path}.manifest.json`, JSON.stringify({ createdAt: new Date().toISOString(), sha256: fileHash(path), database: after }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`Backup e manifesto criados: ${path}`);
    console.log('Guarde uma cópia protegida fora deste computador. Não publique o dump: ele contém dados pessoais e hashes de sessão.');
    return;
  }
  if (!argument) throw new MigrationError('Informe o caminho do backup que será restaurado ou conferido.');
  const manifest = JSON.parse(readFileSync(`${path}.manifest.json`, 'utf8'));
  if (fileHash(path) !== manifest.sha256) throw new MigrationError('O checksum do backup diverge do manifesto. Operação recusada.');
  if (action === 'restore') {
    await withClient(target, assertEmpty);
    pgCommand('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', decodeURIComponent(target.pathname.slice(1)), path], target);
    console.log('Restauração concluída. Conferindo os dados antes de aplicar novas migrações.');
  }
  const actual = await fingerprint(target);
  if (!sameFingerprint(manifest.database, actual)) throw new MigrationError('A cópia diverge do manifesto da origem. Não troque o tráfego; investigue os dados e as versões PostgreSQL.');
  console.log(`Cópia conferida: ${actual.tables.length} tabelas, dados, colunas, índices, constraints, triggers, funções Bilhetou e sequências coincidem.`);
}

module.exports = { databaseUrl, assertDifferent, pgEnvironment, assertEmpty, sameFingerprint };
if (require.main === module) main().catch(error => {
  // Do not serialize pg errors: they can contain connection details.
  console.error(error instanceof MigrationError ? error.message : 'Migração não concluída. Confira arquivo, permissões e conexão. Execute novamente somente após resolver a causa.');
  process.exitCode = 1;
});
