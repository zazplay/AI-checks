import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, apiErrorMessage } from '../lib/api';
import { newId } from '../lib/id';
import { upsertInvoice } from './useInvoices';

/**
 * Cap on simultaneous in-flight uploads. A drag-drop of hundreds of files used
 * to fire every POST at once (Promise.all over all files), saturating the
 * browser's ~6-socket-per-origin pool and hammering the backend's DB/queue in
 * one burst. Uploading in a bounded pool spreads the load and lets the server's
 * 429 backpressure kick in gracefully instead of timing out a wall of requests.
 */
const MAX_CONCURRENT_UPLOADS = 4;

/** One file's row in an upload batch. */
export interface UploadRow {
  key: string;
  name: string;
  /** File size in bytes (for display). */
  size: number;
  /** Upload bytes-sent fraction 0..1 while sending. */
  uploadPct: number;
  /** invoice id once the server accepts it (then status is tracked live). */
  id?: string;
  /** set if the upload request itself failed. */
  uploadError?: string;
}

/**
 * Batch uploader that owns its own row state — NOT React-Query per-call
 * callbacks (those only fire for the LAST mutate() of a shared mutation, which
 * left rows stuck on "Uploading…"). Each file is uploaded via its own awaited
 * promise, so every row reliably gets its id, per-file progress, and errors.
 */
export function useBatchUpload() {
  const qc = useQueryClient();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [active, setActive] = useState(false);
  // Synchronous re-entrancy guard: `active` (state) updates async, so a rapid
  // second drop could slip past it. The ref flips immediately, enforcing ONE
  // upload session at a time — a new batch can't stomp an in-flight one.
  const activeRef = useRef(false);

  const patch = useCallback((key: string, p: Partial<UploadRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }, []);

  /**
   * Upload all files through a bounded concurrency pool (MAX_CONCURRENT_UPLOADS
   * at a time). Returns the id of the first successful upload (for single-file
   * "jump to detail" UX). Only ONE session runs at a time: a drop while a batch
   * is still uploading is rejected (with a notice) instead of replacing it.
   */
  const start = useCallback(
    async (files: File[]): Promise<{ firstId?: string }> => {
      if (activeRef.current) {
        notifications.show({
          color: 'yellow',
          title: 'Upload in progress',
          message: 'Please wait for the current upload session to finish before adding more.',
        });
        return {};
      }
      activeRef.current = true;

      const batch: UploadRow[] = files.map((f) => ({
        key: newId(),
        name: f.name,
        size: f.size,
        uploadPct: 0,
      }));
      setRows(batch);
      setActive(true);

      let firstId: string | undefined;

      const uploadOne = async (file: File, i: number) => {
        const key = batch[i].key;
        try {
          const real = await api.uploadInvoice(file, (pct) =>
            patch(key, { uploadPct: Math.min(0.99, pct / 100) }),
          );
          patch(key, { id: real.id, uploadPct: 1 });
          upsertInvoice(qc, real);
          if (firstId === undefined) firstId = real.id;
        } catch (error) {
          patch(key, { uploadError: apiErrorMessage(error) });
          notifications.show({
            color: 'red',
            title: `Upload failed — ${file.name}`,
            message: apiErrorMessage(error),
          });
        }
      };

      // A shared cursor hands the next file to whichever worker is free, so at
      // most MAX_CONCURRENT_UPLOADS requests are in flight at any moment while
      // still draining the whole list.
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++;
          await uploadOne(files[i], i);
        }
      };
      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENT_UPLOADS, files.length) },
        () => worker(),
      );
      await Promise.all(workers);

      setActive(false);
      activeRef.current = false;
      return { firstId };
    },
    [patch, qc],
  );

  const reset = useCallback(() => {
    // Don't tear down an in-flight session: closing the progress modal (or
    // opening an invoice) mid-batch must NOT clear the re-entrancy guard, or a
    // new drop could start a second concurrent session that stomps `rows`. Just
    // clear the rows display in that case; `start` flips the flags off itself
    // when the batch settles.
    setRows([]);
    if (activeRef.current) return;
    setActive(false);
  }, []);

  return { rows, active, start, reset };
}
