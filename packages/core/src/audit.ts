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

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
 * File-backed audit store with an in-memory mirror.
 *
 * The mirror keeps the dashboard responsive without a query engine; the file
 * remains the source of truth and is re-read on construction.
 */
export class AuditStore {
  private readonly path: string;
  private records: AuditRecord[] = [];
  private loaded = false;

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
    this.records = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditRecord];
        } catch {
          // A truncated final line (power loss mid-append) must not make the
          // whole journal unreadable.
          return [];
        }
      });
    this.loaded = true;
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

    const filtered = this.records
      .filter((r) => (q.decision ? r.decision === q.decision : true))
      .filter((r) => (q.policyId ? r.policyId === q.policyId : true))
      .filter((r) => (q.subjectType ? r.subjectType === q.subjectType : true))
      .filter((r) => (q.from ? r.timestamp >= q.from : true))
      .filter((r) => (q.to ? r.timestamp <= q.to : true))
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
