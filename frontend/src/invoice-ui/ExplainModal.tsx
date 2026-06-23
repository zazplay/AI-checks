import {
  Alert,
  Box,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  TypographyStylesProvider,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconAlertTriangle, IconSparkles } from '@tabler/icons-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useInvoiceUI } from './InvoiceUIContext';

/**
 * One shared "Explain with AI" modal in a violet (grape) theme, opened from
 * anywhere (detail view, cards, chat) via ui.explain(invoice). Replaces the old
 * mix of an inline alert + a toast so the explanation always shows the same way.
 */
export function ExplainModal() {
  const { explainState, closeExplain } = useInvoiceUI();
  const { invoice, summary, loading, error } = explainState;
  const isMobile = useMediaQuery('(max-width: 48em)');

  return (
    <Modal
      opened={invoice !== null}
      onClose={closeExplain}
      size="md"
      centered
      radius="md"
      fullScreen={isMobile}
      // Above the invoice-detail modal (zIndex 400) — it's opened from there, so
      // a default (~200) would hide this modal and its overlay beneath it.
      zIndex={500}
      overlayProps={{ backgroundOpacity: 0.55, blur: 3 }}
      title={
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon
            variant="gradient"
            gradient={{ from: 'grape', to: 'violet', deg: 135 }}
            radius="xl"
            size="lg"
          >
            <IconSparkles size={18} />
          </ThemeIcon>
          <Box style={{ minWidth: 0 }}>
            <Text fw={600}>AI explanation</Text>
            {invoice && (
              <Text size="xs" c="dimmed" truncate title={invoice.originalFilename}>
                {invoice.originalFilename}
              </Text>
            )}
          </Box>
        </Group>
      }
    >
      <Stack gap="md">
        {loading && (
          <Group gap="sm" py="lg" justify="center">
            <Loader color="grape" size="sm" />
            <Text size="sm" c="dimmed">
              Reading the invoice and writing a plain-language summary…
            </Text>
          </Group>
        )}

        {!loading && error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            {error}
          </Alert>
        )}

        {!loading && !error && summary && (
          <Paper
            p="md"
            radius="md"
            withBorder
            style={{
              borderColor: 'var(--mantine-color-grape-3)',
              background:
                'light-dark(var(--mantine-color-grape-0), var(--mantine-color-grape-9))',
            }}
          >
            <TypographyStylesProvider fz="sm" className="chat-md" style={{ minWidth: 0 }}>
              <Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown>
            </TypographyStylesProvider>
          </Paper>
        )}
      </Stack>
    </Modal>
  );
}
