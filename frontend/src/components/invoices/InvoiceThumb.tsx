import { useEffect, useState } from 'react';
import { Box, Center, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCloudUpload,
  IconFileTypePdf,
  IconPhoto,
} from '@tabler/icons-react';
import { useInvoiceFile } from '../../hooks/useInvoiceFile';
import { humanizeError } from '../../lib/format';
import type { Invoice } from '../../types/invoice';

/**
 * Visual preview of an invoice file used in the card gallery.
 * Images render as <img>; PDFs render their first page via an <iframe> with
 * navigation chrome hidden, scaled to fit the card. The blob is fetched with
 * the JWT (a bare URL would 401), so it goes through useInvoiceFile.
 *
 * While the invoice is still being uploaded/processed (or has failed), a
 * status overlay is drawn on top so the async pipeline is visible at a glance.
 */
export function InvoiceThumb({
  invoice,
  height = 160,
}: {
  invoice: Invoice;
  height?: number;
}) {
  const isPdf = invoice.mimeType === 'application/pdf';
  const inProgress =
    invoice.status === 'uploaded' || invoice.status === 'processing';
  const failed = invoice.status === 'failed';

  // Only fetch the file preview once processing is done — during upload/
  // processing the overlay covers the preview anyway, and the file may not be
  // readable yet.
  const { data: blob } = useInvoiceFile(
    invoice.status === 'completed' ? invoice.id : '',
  );
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return undefined;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  const base = (
    <Center h={height} bg="var(--mantine-color-default-hover)">
      <ThemeIcon variant="light" color={isPdf ? 'red' : 'blue'} size={48} radius="md">
        {isPdf ? <IconFileTypePdf size={28} /> : <IconPhoto size={28} />}
      </ThemeIcon>
    </Center>
  );

  let preview = base;
  if (invoice.status === 'completed' && url) {
    preview = isPdf ? (
      <div style={{ height, overflow: 'hidden', background: '#fff' }}>
        <iframe
          src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
          title={invoice.originalFilename}
          tabIndex={-1}
          style={{
            width: '100%',
            height: height * 2.2,
            border: 0,
            pointerEvents: 'none',
          }}
        />
      </div>
    ) : (
      <img
        src={url}
        alt={invoice.originalFilename}
        style={{
          width: '100%',
          height,
          objectFit: 'cover',
          display: 'block',
          background: '#fff',
        }}
      />
    );
  }

  return (
    <Box pos="relative" h={height}>
      {preview}

      {(inProgress || failed) && (
        <Center
          pos="absolute"
          inset={0}
          style={{
            background: failed
              ? 'color-mix(in srgb, var(--mantine-color-red-9) 55%, transparent)'
              : 'color-mix(in srgb, var(--mantine-color-dark-9) 60%, transparent)',
            backdropFilter: 'blur(1px)',
          }}
        >
          <Stack align="center" gap={6}>
            {invoice.status === 'uploaded' && (
              <>
                <ThemeIcon variant="white" color="indigo" radius="xl" size={40}>
                  <IconCloudUpload size={22} />
                </ThemeIcon>
                <Text size="xs" fw={600} c="white">
                  Uploaded — queued
                </Text>
              </>
            )}
            {invoice.status === 'processing' && (
              <>
                <Loader color="white" size="md" />
                <Text size="xs" fw={600} c="white">
                  Extracting data…
                </Text>
              </>
            )}
            {failed && (
              <>
                <ThemeIcon variant="white" color="red" radius="xl" size={40}>
                  <IconAlertTriangle size={22} />
                </ThemeIcon>
                <Text size="xs" fw={600} c="white">
                  Processing failed
                </Text>
                <Text size="xs" c="white" ta="center" px="md" lineClamp={2} opacity={0.85}>
                  {humanizeError(invoice.errorMessage)}
                </Text>
              </>
            )}
          </Stack>
        </Center>
      )}
    </Box>
  );
}
