/**
 * Supabase connectivity and schema check. Diagnostic, not part of the app.
 *
 *   npx tsx scripts/corpus/db-check.ts
 *
 * Answers three questions that are easy to assume and expensive to be wrong
 * about: can we reach the project, has contracts/schema.sql actually been run,
 * and is row level security doing what the schema says it does.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** Every table contracts/schema.sql creates. A missing one means a partial run. */
const TABLES = [
  'users',
  'devices',
  'venues',
  'dishes',
  'duels',
  'logs',
  'prefs',
  'palate_region',
  'reliability',
  'constraints',
  'orgs',
  'org_members',
  'packets',
];

/** Tables the schema puts behind row level security. */
const RLS_TABLES = ['constraints', 'reliability', 'prefs', 'logs'];

async function main(): Promise<void> {
  if (!url || !service) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  console.log(`\nproject: ${url}\n`);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const missing: string[] = [];
  let reachable = false;

  for (const t of TABLES) {
    const { error } = await admin.from(t).select('*', { count: 'exact', head: true });
    if (error) {
      // 42P01 is undefined_table: the schema was not run, or only partly.
      if (error.code === '42P01' || /does not exist/i.test(error.message)) {
        missing.push(t);
        console.log(`  MISSING  ${t}`);
      } else {
        console.log(`  ERROR    ${t}: ${error.message}`);
      }
    } else {
      reachable = true;
      console.log(`  ok       ${t}`);
    }
  }

  if (!reachable) {
    console.log('\nCould not read a single table. Either the key is wrong or the project is unreachable.');
    process.exit(1);
  }

  if (missing.length > 0) {
    console.log(
      `\n${missing.length} table(s) missing. Run contracts/schema.sql in the SQL editor:\n` +
        `  https://supabase.com/dashboard/project/iuuyrfcklpanqehbrljq/sql/new\n`,
    );
    process.exit(1);
  }

  // pgvector: dishes.phi is vector(24), so a successful select above already
  // proves the extension exists. Worth saying explicitly since it is the one
  // piece of the schema that fails separately from the tables.
  console.log('\nAll tables present, so the vector extension installed too.');

  // ---------------------------------------------------------------------
  // RLS. The schema enables it on four tables and the reliability policy is
  // "using (false)", meaning nobody reads it through the anon key ever. If
  // RLS silently did not apply, reliability scores about people would be
  // readable from a browser, which is hard rule 1 failing at the database.
  // ---------------------------------------------------------------------
  if (!anon) {
    console.log('\nNo anon key set, skipping the RLS check.');
    return;
  }

  console.log('\nRLS, read as an anonymous client:');
  const pub = createClient(url, anon, { auth: { persistSession: false } });
  let rlsProblem = false;

  for (const t of RLS_TABLES) {
    const { data, error } = await pub.from(t).select('*').limit(1);
    if (error) {
      console.log(`  ok       ${t}: refused (${error.code ?? 'error'})`);
    } else if ((data ?? []).length === 0) {
      // An empty table cannot distinguish "RLS blocked it" from "no rows", so
      // this is reported honestly rather than counted as a pass.
      console.log(`  empty    ${t}: no rows returned, table may just be empty`);
    } else {
      rlsProblem = true;
      console.log(`  LEAK     ${t}: returned ${data.length} row(s) to an anonymous client`);
    }
  }

  // -----------------------------------------------------------------------
  // The empty-table result above proves nothing, so plant a real row and try
  // to read it back anonymously. reliability is the sharpest case: its policy
  // is "using (false)", so it must be unreadable even to an authenticated
  // user, and a reliability score is precisely the number about a person that
  // hard rule 1 forbids ever reaching a client.
  // -----------------------------------------------------------------------
  console.log('\nRLS, proved with a planted row:');

  const { data: user, error: userErr } = await admin
    .from('users')
    .insert({ handle: `rls-probe-${Date.now()}` })
    .select('id')
    .single();

  if (userErr || !user) {
    console.log(`  could not plant a probe row: ${userErr?.message ?? 'no row returned'}`);
    return;
  }

  try {
    await admin.from('reliability').insert({ user_id: user.id, score: 0.87, n_evaluated: 42 });
    await admin.from('constraints').insert({
      user_id: user.id,
      kind: 'allergy',
      value: 'rls-probe-sentinel',
      consented_at: new Date().toISOString(),
    });

    const rel = await pub.from('reliability').select('*').eq('user_id', user.id);
    if ((rel.data ?? []).length > 0) {
      rlsProblem = true;
      console.log('  LEAK     reliability: a score about a person was readable anonymously');
    } else {
      console.log('  ok       reliability: planted row is invisible to the anon client');
    }

    const con = await pub.from('constraints').select('*').eq('user_id', user.id);
    const leaked = JSON.stringify(con.data ?? []).includes('rls-probe-sentinel');
    if (leaked) {
      rlsProblem = true;
      console.log('  LEAK     constraints: an Article 9 value was readable anonymously');
    } else {
      console.log('  ok       constraints: planted value is invisible to the anon client');
    }
  } finally {
    // Cascades to reliability and constraints, so the probe leaves nothing.
    await admin.from('users').delete().eq('id', user.id);
    console.log('  cleaned up the probe rows');
  }

  console.log(
    rlsProblem
      ? '\nA protected table is readable anonymously. Fix before any real data lands.\n'
      : '\nNo protected table leaked to the anonymous client.\n',
  );
  if (rlsProblem) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
