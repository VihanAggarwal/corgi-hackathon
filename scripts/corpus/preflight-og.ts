/**
 * iMessage link-preview preflight.
 *
 *   npx next build && npx next start &
 *   npx tsx scripts/corpus/preflight-og.ts http://localhost:3000
 *   npx tsx scripts/corpus/preflight-og.ts https://<deployment>
 *
 * Checks the things that decide whether a pasted link becomes a rich card in a
 * Messages thread or a bare blue link. Every one of these fails silently in dev
 * and in preview tools, and only shows up on a real phone in front of judges.
 *
 * This does not replace testing on an actual device. It catches the failures
 * that are mechanical, so device testing can be spent on the ones that are not.
 */

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

interface Check {
  path: string;
  what: string;
}

const CHECKS: Check[] = [
  { path: '/', what: 'root' },
  { path: '/c/p4w9r', what: 'shared duel card (the growth loop)' },
  { path: '/r/pk_1', what: 'shared recommendation' },
];

function tag(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

let failures = 0;

function fail(msg: string): void {
  failures++;
  console.log(`  FAIL  ${msg}`);
}

function pass(msg: string): void {
  console.log(`  ok    ${msg}`);
}

async function check(c: Check): Promise<void> {
  console.log(`\n${c.what}  ${base}${c.path}`);

  let html: string;
  try {
    const res = await fetch(`${base}${c.path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      fail(`page returned ${res.status}`);
      return;
    }
    html = await res.text();
  } catch (err) {
    fail(`page unreachable: ${(err as Error).message}`);
    return;
  }

  const title = tag(html, 'og:title');
  const desc = tag(html, 'og:description');
  const image = tag(html, 'og:image');

  title ? pass(`og:title "${title.slice(0, 54)}"`) : fail('og:title missing');
  desc ? pass('og:description present') : fail('og:description missing');

  if (!image) {
    fail('og:image missing, the thread will show a bare link');
    return;
  }

  // The failure that actually bites: a non-absolute or localhost image URL.
  // Apple's preview fetcher is not on your machine and cannot resolve either.
  if (!/^https?:\/\//i.test(image)) {
    fail(`og:image is not absolute: ${image}`);
    return;
  }
  if (/localhost|127\.0\.0\.1/i.test(image) && !/localhost/i.test(base)) {
    fail(`og:image points at localhost on a remote deploy: ${image}`);
    return;
  }
  pass(`og:image absolute ${image.slice(0, 64)}`);

  // The image must actually render. next/og failing at runtime (a missing font
  // file, an unsupported CSS property) returns a 500 that nothing else surfaces.
  try {
    const img = await fetch(image, { signal: AbortSignal.timeout(20_000) });
    if (!img.ok) {
      fail(`og:image fetch returned ${img.status}, next/og is throwing`);
      return;
    }
    const type = img.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) {
      fail(`og:image content-type is ${type}, expected an image`);
      return;
    }
    const bytes = (await img.arrayBuffer()).byteLength;
    if (bytes < 5_000) {
      fail(`og:image is only ${bytes} bytes, probably a blank render`);
      return;
    }
    pass(`og:image renders, ${type}, ${(bytes / 1024).toFixed(0)}kb`);
  } catch (err) {
    fail(`og:image unreachable: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log(`\niMessage link-preview preflight against ${base}`);
  for (const c of CHECKS) await check(c);

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) failed. A pasted link will not render as a card.\n`);
    process.exit(1);
  }
  console.log('All checks passed. Still paste a link into a real thread before the demo.\n');
}

main();
