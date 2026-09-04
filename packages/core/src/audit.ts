/**
 * Append-only audit journal.
 *
 * Storage is a JSONL file, chosen on purpose: an auditor can read it with
 * `cat`, it needs no database to operate or hand over, and append-only is the
 * property that actually matters for an audit trail. `docs/OPERATIONS.md`
 * covers rotation and retention.
 *
 * What is *not* stored is as important as what is:
 *   - no subject reference (only a salted hash)
 *   - no subject name or label
 *   - no claim values — only the claim ids that were consulted
 *   - no justification free-text
 */

import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname } from "node:path";

import type { AuditRecord, Decision, SubjectType } from "./types.ts";
import { AuditWriteError } from "./errors.ts";

export interface AuditQuery {
  decision?: Decision;
  policyId?: string;
  subjectType?: SubjectType;
  /** Inclusive ISO-8601 lower bound. */
  from?: string;
  /** Inclusive ISO-8601 upper bound. */
  to?: string;
  /** Case-insensitive substring match over resource and audit id. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  records: AuditRecord[];
  total: number;
  offset: number;
  limit: number;
}

export interface AuditStats {
  total: number;
  approved: number;
  reviewRequired: number;
  denied: number;
  byPolicy: Record<string, number>;
  liveDecisions: number;
  demoDecisions: number;
}

/**
 * Parse a query bound into an instant.
 *
 * A bare `YYYY-MM-DD` means the whole of that UTC day, so an `end` bound
 * extends to its last millisecond. An unparseable bound is ignored rather than
 * silently matching nothing — a typo in a filter must not look like "there are
 * no records", which is the most misleading answer an audit log can give.
 */
function boundToMs(value: string | undefined, edge: "start" | "end"): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const ms = Date.parse(`${trimmed}T00:00:00.000Z`);
    if (Number.isNaN(ms)) return null;
    return edge === "start" ? ms : ms + 86_400_000 - 1;
  }

  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * File-backed audit store with an in-memory mirror.
 *
 * The mirror keeps the dashboard responsive without a query engine; the file
 * remains the source of truth and is re-read on construction.
 */
export class AuditStore {
  private readonly path: string;
  private records: AuditRecord[] = [];
  private loaded = false;
  /** True when init() found and repaired a torn trailing line. */
  private corruptionRepaired = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Read the journal from disk. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.loaded) return;
    if (!existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const raw = await readFile(this.path, "utf8");
    let torn = false;
    this.records = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditRecord];
        } catch {
          // A truncated line (power loss mid-append) must not make the whole
          // journal unreadable.
          torn = true;
          return [];
        }
      });

    // Skipping a torn line on read is not enough. If the file does not end in a
    // newline, the next `append()` writes onto the end of that partial line and
    // fuses the two into a single unparseable record — so one interrupted write
    // silently destroys the *next* decision too, and that one was written
    // successfully. Terminate the line before anything else is appended.
    if (raw.length > 0 && !raw.endsWith("\n")) {
      await appendFile(this.path, "\n", "utf8");
      torn = true;
    }
    if (torn) this.corruptionRepaired = true;

    this.loaded = true;
  }

  /** Whether the journal was found damaged and repaired on load. */
  get wasRepaired(): boolean {
    return this.corruptionRepaired;
  }

  /**
   * Whether a decision could actually be recorded right now.
   *
   * Read separately from `append` because the failure this catches is silent:
   * `init()` only ever reads, so a journal on a read-only mount, or under a
   * path the process cannot create, loads perfectly and the service reports
   * itself healthy — right up until the first decision, which then 500s, as
   * does every one after it. Probing the directory (not the file, which may
   * legitimately not exist yet) is what makes that visible before it bites.
   */
  async writable(): Promise<{ writable: boolean; reason: string | null }> {
    const dir = dirname(this.path);
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
      if (existsSync(this.path)) await access(this.path, constants.W_OK);
      return { writable: true, reason: null };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        writable: false,
        // The path is operator-facing configuration, not user data, and naming
        // it is the difference between a usable alert and a mystery.
        reason: `the audit journal at ${this.path} is not writable${code ? ` (${code})` : ""}`,
      };
    }
  }

  async append(record: AuditRecord): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
      this.records.push(record);
    } catch (err) {
      throw new AuditWriteError(err instanceof Error ? err.message : String(err), {
        cause: err,
        internal: { path: this.path },
      });
    }
  }

  query(q: AuditQuery = {}): AuditPage {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);
    const search = q.search?.trim().toLowerCase();
    const fromMs = boundToMs(q.from, "start");
    const toMs = boundToMs(q.to, "end");

    const filtered = this.records
      .filter((r) => (q.decision ? r.decision === q.decision : true))
      .filter((r) => (q.policyId ? r.policyId === q.policyId : true))
      .filter((r) => (q.subjectType ? r.subjectType === q.subjectType : true))
      // Bounds are compared as instants, not as strings. `to=2026-09-04` is a
      // date, and every record that day carries a full timestamp, so the string
      // test `"2026-09-04T10:06:00Z" <= "2026-09-04"` is false — an inclusive
      // upper bound silently excluded the entire last day of the range, which
      // for an auditor pulling "everything up to the incident date" is a
      // missing-evidence bug, not a display quirk.
      .filter((r) => (fromMs === null ? true : Date.parse(r.timestamp) >= fromMs))
      .filter((r) => (toMs === null ? true : Date.parse(r.timestamp) <= toMs))
      .filter((r) =>
        search
          ? r.resource.toLowerCase().includes(search) ||
            r.auditId.toLowerCase().includes(search) ||
            r.policyId.toLowerCase().includes(search)
          : true,
      )
      // Newest first.
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

    return {
      records: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
    };
  }

  get(auditId: string): AuditRecord | null {
    return this.records.find((r) => r.auditId === auditId) ?? null;
  }

  stats(): AuditStats {
    const byPolicy: Record<string, number> = {};
    let approved = 0;
    let reviewRequired = 0;
    let denied = 0;
    let liveDecisions = 0;
    let demoDecisions = 0;

    for (const r of this.records) {
      byPolicy[r.policyId] = (byPolicy[r.policyId] ?? 0) + 1;
      if (r.decision === "APPROVED") approved++;
      else if (r.decision === "REVIEW_REQUIRED") reviewRequired++;
      else denied++;
      if (r.claimSource === "LIVE_T3N") liveDecisions++;
      else demoDecisions++;
    }

    return {
      total: this.records.length,
      approved,
      reviewRequired,
      denied,
      byPolicy,
      liveDecisions,
      demoDecisions,
    };
  }

  /** Most recent `n` records, newest first. */
  recent(n = 10): AuditRecord[] {
    return this.query({ limit: n }).records;
  }
}
