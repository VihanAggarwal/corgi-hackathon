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

/**
 * Reads, or silently creates, the device id. Safe to call in an event handler.
 *
 * A `?d=` in the URL WINS and is adopted permanently. That parameter is how the
 * iMessage agent hands its conversation to the browser: without it, the phone
 * and the browser are two unrelated strangers, the swipes land under a random
 * local id, and the agent that sent you the link can never see them. That was a
 * real bug, not a hypothetical.
 *
 * Adopting overwrites any previous id on purpose. Someone who follows a fresh
 * link from the agent is telling us which profile they are, and the link is
 * more authoritative than whatever this browser happened to generate earlier.
 */
export function deviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const fromLink = new URLSearchParams(window.location.search).get("d");
    if (fromLink && /^[A-Za-z0-9_-]{4,64}$/.test(fromLink)) {
      if (window.localStorage.getItem(DEVICE_KEY) !== fromLink) {
        window.localStorage.setItem(DEVICE_KEY, fromLink);
      }
      return fromLink;
    }
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
