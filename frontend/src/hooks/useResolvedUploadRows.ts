import { useMemo } from 'react';
import { useInvoices } from './useInvoices';
import type { UploadRow } from './useBatchUpload';
import type { InvoiceStatus } from '../types/invoice';

/** Effective per-row stage: upload phase, then the invoice's live status. */
export type UploadStage = 'sending' | 'upload-failed' | InvoiceStatus;

const SETTLED: UploadStage[] = ['completed', 'failed', 'upload-failed'];

export interface ResolvedUploadRow extends UploadRow {
  stage: UploadStage;
  errorMessage: string | null;
}

export interface ResolvedUploadBatch {
  rows: ResolvedUploadRow[];
  total: number;
  done: number;
  failed: number;
  /** Every row has reached a terminal stage. */
  allDone: boolean;
}

/**
 * Single source of truth for an upload batch's live state. Resolves each row's
 * effective stage from the shared invoices cache (kept current by the socket),
 * so the dropzone parent and the progress panel agree on "done"/"failed" — they
 * both derive from the SAME per-row live status, not from the eventually-
 * consistent global SQL stats.
 */
export function useResolvedUploadRows(rows: UploadRow[]): ResolvedUploadBatch {
  const { data: invoices = [] } = useInvoices();

  return useMemo(() => {
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const resolved: ResolvedUploadRow[] = rows.map((r) => {
      const inv = r.id ? byId.get(r.id) : undefined;
      let stage: UploadStage;
      if (r.uploadError) stage = 'upload-failed';
      // Once the server has accepted the file we have an id; drive the stage from
      // the invoice's live status. If the row hasn't reached an id yet, it's
      // still sending. (The id is set the moment upload resolves, so no gap.)
      else if (r.id) stage = inv?.status ?? 'uploaded';
      else stage = 'sending';
      return { ...r, stage, errorMessage: inv?.errorMessage ?? r.uploadError ?? null };
    });

    const total = resolved.length;
    const done = resolved.filter((r) => SETTLED.includes(r.stage)).length;
    const failed = resolved.filter(
      (r) => r.stage === 'failed' || r.stage === 'upload-failed',
    ).length;

    // Auto-sort so finished files float to the front (completed first), still-
    // working ones in the middle, failures last (so they stay visible and don't
    // get buried). Stable within each group — preserve the original drop order
    // via the index tiebreaker so cards don't jump around arbitrarily.
    const sorted = resolved
      .map((r, i) => ({ r, i }))
      .sort((a, b) => stageRank(a.r.stage) - stageRank(b.r.stage) || a.i - b.i)
      .map(({ r }) => r);

    return { rows: sorted, total, done, failed, allDone: total > 0 && done === total };
  }, [rows, invoices]);
}

/** Sort weight: completed → in-progress → failed. Lower sorts first. */
function stageRank(stage: UploadStage): number {
  if (stage === 'completed') return 0;
  if (stage === 'failed' || stage === 'upload-failed') return 2;
  return 1; // sending / uploaded / processing
}
