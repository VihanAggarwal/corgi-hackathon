/**
 * A fake Supabase client for seed.ts / reset.ts tests. Track C.
 *
 * Not a mock of behavior, an actual tiny in-memory table store: `.upsert`
 * really upserts into a Map keyed by the given conflict column, `.delete().in`
 * really deletes matching rows. That is what lets seed.test.ts and
 * reset.test.ts assert a real round trip, seed then reset then nothing left,
 * without touching a network or the real Supabase project this repo's
 * .env.local happens to point at.
 *
 * Deliberately untyped against @supabase/supabase-js's SupabaseClient: this
 * only has to satisfy the three call shapes seed.ts and reset.ts actually use
 * (`.from(t).upsert(rows)`, `.from(t).upsert(rows, {onConflict})`,
 * `.from(t).delete().in(col, vals)`), and a structural type covering the
 * whole real client would be a maintenance burden for no test value.
 */

export interface FakeRow {
  [column: string]: unknown;
}

export interface FakeTable {
  rows: Map<string, FakeRow>;
}

export interface FakeSupabaseClient {
  tables: Map<string, FakeTable>;
  from(table: string): {
    upsert(rows: FakeRow[], opts?: { onConflict?: string }): Promise<{ error: null }>;
    delete(): { in(column: string, values: string[]): Promise<{ error: null }> };
  };
}

export function createFakeSupabaseClient(): FakeSupabaseClient {
  const tables = new Map<string, FakeTable>();

  function tableFor(name: string): FakeTable {
    let t = tables.get(name);
    if (!t) {
      t = { rows: new Map() };
      tables.set(name, t);
    }
    return t;
  }

  return {
    tables,
    from(name: string) {
      const table = tableFor(name);
      return {
        async upsert(rows: FakeRow[], opts?: { onConflict?: string }) {
          const key = opts?.onConflict ?? 'id';
          for (const row of rows) table.rows.set(String(row[key]), row);
          return { error: null };
        },
        delete() {
          return {
            async in(column: string, values: string[]) {
              const wanted = new Set(values.map(String));
              for (const [rowKey, row] of table.rows) {
                if (wanted.has(String(row[column]))) table.rows.delete(rowKey);
              }
              return { error: null };
            },
          };
        },
      };
    },
  };
}
