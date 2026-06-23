import { SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { formatDate, formatMoney } from '../../lib/format';
import type { ExtractedInvoice } from '../../types/invoice';

/** A labelled field; empty values render dimmed as "—" so gaps are visible. */
function Field({ label, value, empty }: { label: string; value: string; empty?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} truncate>
        {label}
      </Text>
      <Text size="sm" c={empty ? 'dimmed' : undefined} fs={empty ? 'italic' : undefined} truncate title={value}>
        {value}
      </Text>
    </div>
  );
}

/** A small section heading inside the detail body. */
function SectionLabel({ children }: { children: string }) {
  return (
    <Text size="xs" tt="uppercase" fw={700} c="dimmed" mt={4}>
      {children}
    </Text>
  );
}

/** Nulls render as "—" on purpose: seeing what the model failed to extract is the point. */
export function ExtractedDataView({ data }: { data: ExtractedInvoice }) {
  return (
    <Stack gap="md">
      {/* Section: invoice identity / dates */}
      <Stack gap="xs">
        <SectionLabel>Invoice info</SectionLabel>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Field label="Vendor" value={data.vendorName ?? '—'} empty={data.vendorName == null} />
          <Field label="Invoice #" value={data.invoiceNumber ?? '—'} empty={data.invoiceNumber == null} />
          <Field label="Invoice date" value={formatDate(data.invoiceDate)} empty={data.invoiceDate == null} />
          <Field label="Due date" value={formatDate(data.dueDate)} empty={data.dueDate == null} />
        </SimpleGrid>
      </Stack>

      {/* Section: monetary amounts */}
      <Stack gap="xs">
        <SectionLabel>Amounts</SectionLabel>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Field label="Subtotal" value={formatMoney(data.subtotal, data.currency)} empty={data.subtotal == null} />
          <Field label="Tax" value={formatMoney(data.tax, data.currency)} empty={data.tax == null} />
          <Field label="Total" value={formatMoney(data.total, data.currency)} empty={data.total == null} />
          <Field label="Currency" value={data.currency ?? '—'} empty={data.currency == null} />
        </SimpleGrid>
      </Stack>

      {/* Section: line items */}
      {data.lineItems.length > 0 && (
        <Stack gap="xs">
          <SectionLabel>{`Line items (${data.lineItems.length})`}</SectionLabel>
          <Table.ScrollContainer minWidth={420}>
            <Table striped withTableBorder verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Description</Table.Th>
                  <Table.Th ta="right">Qty</Table.Th>
                  <Table.Th ta="right">Unit price</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.lineItems.map((item, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>{item.description}</Table.Td>
                    <Table.Td ta="right">{item.quantity ?? '—'}</Table.Td>
                    <Table.Td ta="right">{formatMoney(item.unitPrice, data.currency)}</Table.Td>
                    <Table.Td ta="right">{formatMoney(item.amount, data.currency)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      )}

      {data.lineItems.length === 0 && (
        <Stack gap="xs">
          <SectionLabel>Line items</SectionLabel>
          <Text size="sm" c="dimmed" fs="italic">
            No line items were extracted.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}
