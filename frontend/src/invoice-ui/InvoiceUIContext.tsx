import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { useMutation } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { useRetryInvoice } from '../hooks/useRetryInvoice';
import { api, apiErrorMessage } from '../lib/api';
import type { Invoice, InvoiceStatus } from '../types/invoice';
import type { NavigateIntent } from '../types/assistant';

type Tab = 'upload' | 'all' | 'analytics';

/** The AI-explanation modal's current state (one shared modal for the whole app). */
export interface ExplainState {
  invoice: Invoice | null;
  summary: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * One shared source of truth for "what the app is showing" and "what can be done
 * to an invoice". Both the InvoicePanel (main view) and the AssistantChat (aside)
 * read and drive it, so the assistant can navigate the app and act on invoices
 * exactly like the user can — open a detail modal, switch tabs, filter, retry,
 * delete, download, and trigger an upload.
 */
interface InvoiceUI {
  // navigation state
  tab: Tab;
  setTab: (tab: Tab) => void;
  detailId: string | null;
  openInvoice: (id: string | null) => void;
  statusFilter: InvoiceStatus | null;
  setStatusFilter: (s: InvoiceStatus | null) => void;
  search: string;
  setSearch: (s: string) => void;

  // upload trigger — pass uploadOpenerRef to Dropzone.openRef; openUpload() fires it
  uploadOpenerRef: MutableRefObject<(() => void) | null>;
  openUpload: () => void;

  // invoice actions
  retry: (id: string) => void;
  requestDelete: (invoice: Invoice) => void;
  download: (invoice: Invoice) => Promise<void>;
  retryingId: string | null;

  // AI explanation — one shared violet modal, opened from anywhere
  explain: (invoice: Invoice) => void;
  explainState: ExplainState;
  closeExplain: () => void;

  // export (download) — used by the Export button and the assistant's tool
  exportInvoices: (format: ExportFormat, filter?: ExportFilter) => Promise<void>;
  /** Download an already-built export URL (the assistant returns one). */
  downloadExportUrl: (url: string, filename: string) => Promise<void>;
  exporting: boolean;

  // execute a batch of intents from the assistant's navigate_ui tool
  applyNavigation: (intent: NavigateIntent) => void;
}

export type ExportFormat = 'xlsx' | 'csv' | 'zip';

export interface ExportFilter {
  status?: InvoiceStatus;
  vendor?: string;
  minTotal?: number;
  maxTotal?: number;
  search?: string;
}

const InvoiceUIContext = createContext<InvoiceUI | null>(null);

/** Save a blob to the user's disk by clicking a temporary object-URL link. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Build the relative export URL from a format + filters (matches the backend route). */
function exportUrl(format: ExportFormat, filter: ExportFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.vendor) params.set('vendor', filter.vendor);
  if (filter.minTotal != null) params.set('minTotal', String(filter.minTotal));
  if (filter.maxTotal != null) params.set('maxTotal', String(filter.maxTotal));
  if (filter.search) params.set('search', filter.search);
  const qs = params.toString();
  return `/invoices/export/${format}${qs ? `?${qs}` : ''}`;
}

export function InvoiceUIProvider({
  children,
  onRequestDelete,
}: {
  children: ReactNode;
  /** The panel owns the delete-confirmation modal; we hand it the target. */
  onRequestDelete: (invoice: Invoice) => void;
}) {
  const [tab, setTab] = useState<Tab>('upload');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | null>(null);
  const [search, setSearch] = useState('');
  const uploadOpenerRef = useRef<(() => void) | null>(null);

  const retryMutation = useRetryInvoice();

  const openUpload = useCallback(() => {
    setTab('upload');
    // The opener is null while a batch/queue is in flight (the dropzone is
    // showing the progress panel instead). Tell the user why the file dialog
    // didn't open instead of silently no-op'ing.
    if (uploadOpenerRef.current) {
      uploadOpenerRef.current();
    } else {
      notifications.show({
        color: 'yellow',
        title: 'Upload in progress',
        message: 'Please wait for the current upload to finish before adding more.',
      });
    }
  }, []);

  const retry = useCallback((id: string) => retryMutation.mutate(id), [retryMutation]);

  // ---- AI explanation modal (one shared violet modal) ----
  const [explainTarget, setExplainTarget] = useState<Invoice | null>(null);
  const explainMutation = useMutation({
    mutationFn: (id: string) => api.explainInvoice(id),
  });

  const explain = useCallback(
    (invoice: Invoice) => {
      setExplainTarget(invoice);
      explainMutation.reset();
      explainMutation.mutate(invoice.id);
    },
    [explainMutation],
  );

  const closeExplain = useCallback(() => {
    setExplainTarget(null);
    explainMutation.reset();
  }, [explainMutation]);

  const explainState = useMemo<ExplainState>(
    () => ({
      invoice: explainTarget,
      summary: explainMutation.data?.summary ?? null,
      loading: explainMutation.isPending,
      error: explainMutation.isError ? apiErrorMessage(explainMutation.error) : null,
    }),
    [explainTarget, explainMutation.data, explainMutation.isPending, explainMutation.isError, explainMutation.error],
  );

  // ---- export / download ----
  const [exporting, setExporting] = useState(false);

  const downloadExportUrl = useCallback(async (url: string, filename: string) => {
    setExporting(true);
    try {
      const blob = await api.downloadExport(url);
      saveBlob(blob, filename);
    } catch (error) {
      notifications.show({ color: 'red', title: 'Export failed', message: apiErrorMessage(error) });
    } finally {
      setExporting(false);
    }
  }, []);

  const exportInvoices = useCallback(
    async (format: ExportFormat, filter: ExportFilter = {}) => {
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadExportUrl(exportUrl(format, filter), `invoices_${stamp}.${format}`);
    },
    [downloadExportUrl],
  );

  const download = useCallback(async (invoice: Invoice) => {
    try {
      const blob = await api.getInvoiceFile(invoice.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = invoice.originalFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      notifications.show({
        color: 'red',
        title: 'Download failed',
        message: 'Could not fetch the original file.',
      });
    }
  }, []);

  const applyNavigation = useCallback((intent: NavigateIntent) => {
    if (intent.tab) setTab(intent.tab);
    if (intent.statusFilter !== undefined) {
      setStatusFilter(intent.statusFilter === 'all' ? null : intent.statusFilter);
      // status filtering lives on the upload tab's list
      if (intent.statusFilter && intent.statusFilter !== 'all' && !intent.tab) {
        setTab('upload');
      }
    }
    if (intent.search !== undefined) setSearch(intent.search);
    if (intent.openInvoiceId) setDetailId(intent.openInvoiceId);
    if (intent.openUpload) {
      setTab('upload');
      uploadOpenerRef.current?.();
    }
  }, []);

  const value = useMemo<InvoiceUI>(
    () => ({
      tab,
      setTab,
      detailId,
      openInvoice: setDetailId,
      statusFilter,
      setStatusFilter,
      search,
      setSearch,
      uploadOpenerRef,
      openUpload,
      retry,
      requestDelete: onRequestDelete,
      download,
      retryingId: retryMutation.isPending ? (retryMutation.variables ?? null) : null,
      explain,
      explainState,
      closeExplain,
      exportInvoices,
      downloadExportUrl,
      exporting,
      applyNavigation,
    }),
    [
      tab,
      detailId,
      statusFilter,
      search,
      openUpload,
      retry,
      onRequestDelete,
      download,
      retryMutation.isPending,
      retryMutation.variables,
      explain,
      explainState,
      closeExplain,
      exportInvoices,
      downloadExportUrl,
      exporting,
      applyNavigation,
    ],
  );

  return <InvoiceUIContext.Provider value={value}>{children}</InvoiceUIContext.Provider>;
}

export function useInvoiceUI(): InvoiceUI {
  const ctx = useContext(InvoiceUIContext);
  if (!ctx) throw new Error('useInvoiceUI must be used within InvoiceUIProvider');
  return ctx;
}
