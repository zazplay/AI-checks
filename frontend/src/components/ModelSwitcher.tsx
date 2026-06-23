import { Select, Tooltip } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { IconCpu } from '@tabler/icons-react';
import { api, apiErrorMessage } from '../lib/api';

/**
 * PRIMARY extraction-engine switcher. Picks which engine reads an uploaded
 * invoice FIRST — Claude Haiku (the default, vision) or one of the Gemini vision
 * models. The other engines remain as fallbacks in the cascade. The assistant
 * chat engine is chosen separately (AssistantEngineSwitcher).
 */
export function ModelSwitcher() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['ai-models'], queryFn: api.getModels });

  const mutation = useMutation({
    mutationFn: (model: string) => api.setModel(model),
    onSuccess: (res) => {
      qc.setQueryData(['ai-models'], res);
      notifications.show({
        color: 'indigo',
        title: 'Extraction engine',
        message: `Switched to ${res.current}`,
      });
    },
    onError: (error) =>
      notifications.show({ color: 'red', title: 'Could not switch engine', message: apiErrorMessage(error) }),
  });

  // Group the flat model list into Claude vs Gemini so the dropdown reads clearly.
  const available = data?.available ?? [];
  const groups = [
    {
      group: 'Claude',
      items: available.filter((m) => m.startsWith('claude')),
    },
    {
      group: 'Gemini',
      items: available.filter((m) => m.startsWith('gemini')),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <Tooltip label="Primary extraction engine (Claude Haiku or Gemini); others stay as fallback">
      <Select
        size="xs"
        w={{ base: 150, lg: 180 }}
        leftSection={<IconCpu size={14} />}
        data={groups}
        value={data?.current ?? null}
        onChange={(v) => v && mutation.mutate(v)}
        disabled={!data || mutation.isPending}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
        aria-label="Extraction engine"
      />
    </Tooltip>
  );
}
