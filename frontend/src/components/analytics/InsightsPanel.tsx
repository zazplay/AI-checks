import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Group,
  List,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconSparkles } from '@tabler/icons-react';
import { api, apiErrorMessage } from '../../lib/api';
import type { Insights } from '../../types/assistant';

/** AI-powered insights: deterministic anomalies + a Gemini narrative summary. */
export function InsightsPanel() {
  const mutation = useMutation({
    mutationFn: () => api.analyze(),
  });
  const data = mutation.data as Insights | undefined;

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
            <ThemeIcon variant="light" color="grape" radius="xl" style={{ flexShrink: 0 }}>
              <IconSparkles size={16} />
            </ThemeIcon>
            <Title order={5} lineClamp={1}>
              AI insights
            </Title>
          </Group>
          <Button
            size="xs"
            variant="light"
            color="grape"
            leftSection={<IconSparkles size={14} />}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
            style={{ flexShrink: 0 }}
          >
            Analyze invoices
          </Button>
        </Group>

        {mutation.isError && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            {apiErrorMessage(mutation.error)}
          </Alert>
        )}

        {!data && !mutation.isPending && (
          <Text size="sm" c="dimmed">
            Run an analysis to get a narrative summary and detect anomalies
            (duplicates, unusually high amounts).
          </Text>
        )}

        {data && (
          <Stack gap="sm">
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {data.summary}
            </Text>
            <Group gap="xs">
              <Text size="sm" fw={600}>
                Anomalies
              </Text>
              <Badge variant="light" color={data.anomalies.length ? 'orange' : 'teal'}>
                {data.anomalies.length}
              </Badge>
            </Group>
            {data.anomalies.length > 0 ? (
              <List spacing="xs" size="sm">
                {data.anomalies.map((a, i) => (
                  <List.Item
                    key={i}
                    icon={
                      <ThemeIcon
                        size="sm"
                        radius="xl"
                        color={a.type === 'duplicate' ? 'yellow' : 'orange'}
                      >
                        <IconAlertTriangle size={12} />
                      </ThemeIcon>
                    }
                  >
                    {a.message}
                  </List.Item>
                ))}
              </List>
            ) : (
              <Text size="sm" c="dimmed">
                No anomalies detected.
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
