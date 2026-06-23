import { Select, Tooltip } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { IconMessageChatbot } from '@tabler/icons-react';
import { api, apiErrorMessage, type AssistantProvider } from '../lib/api';

const PROVIDER_LABEL: Record<AssistantProvider, string> = {
  gemini: 'Gemini',
  groq: 'Groq (big free quota)',
  claude: 'Claude (Haiku)',
};

/** Encode/decode provider+model into a single Select value. */
const enc = (provider: AssistantProvider, model: string) => `${provider}::${model}`;
const dec = (value: string) => {
  const [provider, model] = value.split('::');
  return { provider: provider as AssistantProvider, model };
};

/**
 * Switches the CHAT assistant engine (Gemini or Groq), independent of the
 * extraction model. Groq's free quota is far larger, so it's the place to run
 * the chatty assistant; extraction stays on Gemini's vision model.
 */
export function AssistantEngineSwitcher() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['assistant-engine'],
    queryFn: api.getAssistantEngine,
  });

  const mutation = useMutation({
    mutationFn: ({ provider, model }: { provider: AssistantProvider; model: string }) =>
      api.setAssistantEngine(provider, model),
    onSuccess: (res) => {
      qc.setQueryData(['assistant-engine'], res);
      notifications.show({
        color: 'indigo',
        title: 'Assistant engine',
        message: `Switched to ${res.current.provider} / ${res.current.model}`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: 'red',
        title: 'Could not switch engine',
        message: apiErrorMessage(error),
      }),
  });

  // Group options by provider; disable any engine whose key isn't configured.
  const groups = (['gemini', 'groq', 'claude'] as AssistantProvider[]).map((provider) => ({
    group: PROVIDER_LABEL[provider],
    items: (data?.options ?? [])
      .filter((o) => o.provider === provider)
      .map((o) => ({
        value: enc(o.provider, o.model),
        label: o.model,
        disabled: !o.available,
      })),
  }));

  const value = data ? enc(data.current.provider, data.current.model) : null;

  return (
    <Tooltip label="Assistant chat engine (extraction always uses Gemini)">
      <Select
        size="xs"
        w={{ base: 180, lg: 230 }}
        leftSection={<IconMessageChatbot size={14} />}
        data={groups}
        value={value}
        onChange={(v) => v && mutation.mutate(dec(v))}
        disabled={!data || mutation.isPending}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
        aria-label="Assistant engine"
      />
    </Tooltip>
  );
}
