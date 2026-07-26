"use client";

/**
 * Device-scoped profile. Created silently on the first interaction: no account,
 * no email, no install, no "sign up to continue" anywhere. A shared card must
 * be playable by a phone that has never seen this product.
 *
 * Local storage only. Nothing here is identity — it is a handle Track C can
 * later attach a row to.
 */

const DEVICE_KEY = "tt.device";
const PICKS_KEY = "tt.picks";

function makeId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads, or silently creates, the device id. Safe to call in an event handler. */
export function deviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = makeId();
    window.localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return "ephemeral";
  }
}

export interface StoredPick {
  dishA: string;
  dishB: string;
  winner: string;
  at: number;
}

export function readPicks(): StoredPick[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PICKS_KEY);
    return raw ? (JSON.parse(raw) as StoredPick[]) : [];
  } catch {
    return [];
  }
}

export function appendPick(pick: StoredPick): number {
  if (typeof window === "undefined") return 0;
  try {
    const next = [...readPicks(), pick];
    window.localStorage.setItem(PICKS_KEY, JSON.stringify(next));
    return next.length;
  } catch {
    return 0;
  }
}

export function clearPicks(): void {
  try {
    window.localStorage.removeItem(PICKS_KEY);
  } catch {
    /* nothing to clear */
  }
}
