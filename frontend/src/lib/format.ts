/**
 * Turn a stored invoice error (which for older rows can be a raw Gemini JSON
 * blob) into a short, human sentence for the UI.
 */
export function humanizeError(message: string | null | undefined): string {
  if (!message) return 'Processing failed.';
  let text = message;
  // Old rows stored the raw `{"error":{"code":429,"message":"..."}}` JSON.
  try {
    const parsed = JSON.parse(text) as { error?: { code?: number; message?: string } };
    if (parsed.error?.message) text = parsed.error.message;
  } catch {
    /* not JSON — use as-is */
  }
  const lower = text.toLowerCase();
  if (lower.includes('quota') || lower.includes('429') || lower.includes('rate limit')) {
    return 'AI quota exceeded — too many requests. Retry in a minute.';
  }
  if (lower.includes('no pages') || lower.includes('corrupt')) {
    return 'The file could not be read (corrupted or unsupported PDF).';
  }
  if (lower.includes('password') || lower.includes('encrypt')) {
    return 'The PDF is password-protected and cannot be read.';
  }
  // Trim anything still too long (e.g. a stray URL).
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return formatDateTime(iso);
}

/** Human-readable label for an extracted-field name (used by "Missing: …"). */
const FIELD_LABELS: Record<string, string> = {
  vendorName: 'vendor',
  invoiceNumber: 'invoice #',
  invoiceDate: 'invoice date',
  dueDate: 'due date',
  currency: 'currency',
  subtotal: 'subtotal',
  tax: 'tax',
  total: 'total',
  lineItems: 'line items',
};

export function fieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

export function formatMoney(
  value: number | null,
  currency: string | null,
): string {
  if (value == null) return '—';
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  }
  return value.toFixed(2);
}
