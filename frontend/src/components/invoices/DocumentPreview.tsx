import { useEffect, useState } from 'react';
import { Alert, Center, Loader } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useInvoiceFile } from '../../hooks/useInvoiceFile';
import { apiErrorMessage } from '../../lib/api';
import type { Invoice } from '../../types/invoice';

/** Renders the original file: PDFs via the browser's built-in viewer, images directly. */
export function DocumentPreview({ invoice }: { invoice: Invoice }) {
  const { data: blob, isLoading, error } = useInvoiceFile(invoice.id);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return undefined;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  if (error) {
    return (
      <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Could not load file">
        {apiErrorMessage(error)}
      </Alert>
    );
  }

  if (isLoading || !url) {
    return (
      <Center mih={320}>
        <Loader />
      </Center>
    );
  }

  if (invoice.mimeType === 'application/pdf') {
    return (
      <iframe
        src={url}
        title={invoice.originalFilename}
        style={{ width: '100%', height: '75vh', border: 0, borderRadius: 8 }}
      />
    );
  }

  return (
    <img
      src={url}
      alt={invoice.originalFilename}
      style={{
        maxWidth: '100%',
        maxHeight: '75vh',
        display: 'block',
        margin: '0 auto',
        borderRadius: 8,
      }}
    />
  );
}
