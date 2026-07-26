/**
 * Crash-safe checkpointing for the corpus pipeline. Track A.
 *
 * The extraction pass is the most token-expensive thing in the build. A crash
 * at dish 7,400 that re-runs from zero is a hackathon-ending event, so every
 * completed unit of work is durably recorded before the next one starts.
 *
 * Format is JSONL, appended never rewritten, so a kill -9 mid-write costs at
 * most the final partial line, which is discarded on load.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { PATHS } from './config';

export class Checkpoint<T extends { key: string }> {
  private readonly file: string;
  private stream: WriteStream | null = null;
  private done = new Map<string, T>();

  constructor(name: string) {
    this.file = join(PATHS.checkpoints, `${name}.jsonl`);
    mkdirSync(dirname(this.file), { recursive: true });
    this.load();
  }

  /**
   * Read prior progress. A trailing partial line from an interrupted write is
   * dropped rather than throwing: losing one record is always better than
   * refusing to resume.
   */
  private load(): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, 'utf8').split('\n');
    let dropped = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as T;
        this.done.set(rec.key, rec);
      } catch {
        dropped++;
      }
    }
    if (dropped > 0) {
      console.warn(`[checkpoint:${this.file}] dropped ${dropped} unparseable line(s)`);
    }
  }

  has(key: string): boolean {
    return this.done.has(key);
  }

  get(key: string): T | undefined {
    return this.done.get(key);
  }

  get size(): number {
    return this.done.size;
  }

  all(): T[] {
    return [...this.done.values()];
  }

  /** Record a completed unit. Durable before the caller proceeds. */
  record(rec: T): void {
    this.done.set(rec.key, rec);
    if (!this.stream) {
      this.stream = createWriteStream(this.file, { flags: 'a' });
    }
    this.stream.write(JSON.stringify(rec) + '\n');
  }

  /** Filter a work list down to what has not been done yet. */
  pending<W>(items: W[], keyOf: (item: W) => string): W[] {
    return items.filter((i) => !this.has(keyOf(i)));
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    this.stream = null;
  }
}
