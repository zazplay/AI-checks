import { Button, Menu } from '@mantine/core';
import {
  IconDownload,
  IconFileSpreadsheet,
  IconFileTypeCsv,
  IconFileZip,
} from '@tabler/icons-react';
import { useInvoiceUI, type ExportFilter } from '../../invoice-ui/InvoiceUIContext';

/**
 * Export the (optionally filtered) invoices as Excel, CSV, or a zip of the
 * original files. Hits the same backend endpoints the assistant's export tool
 * uses, so the user and the AI export identically.
 */
export function ExportMenu({
  filter,
  size = 'xs',
}: {
  /** Filters to apply to the export (defaults to none = everything). */
  filter?: ExportFilter;
  size?: string;
}) {
  const ui = useInvoiceUI();

  return (
    <Menu shadow="md" position="bottom-end" withinPortal>
      <Menu.Target>
        <Button
          size={size}
          variant="light"
          leftSection={<IconDownload size={14} />}
          loading={ui.exporting}
        >
          Export
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Download invoices</Menu.Label>
        <Menu.Item
          leftSection={<IconFileSpreadsheet size={16} />}
          onClick={() => void ui.exportInvoices('xlsx', filter)}
        >
          Excel (.xlsx)
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileTypeCsv size={16} />}
          onClick={() => void ui.exportInvoices('csv', filter)}
        >
          CSV
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileZip size={16} />}
          onClick={() => void ui.exportInvoices('zip', filter)}
        >
          ZIP of original files
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
