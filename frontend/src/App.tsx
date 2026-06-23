import {
  ActionIcon,
  AppShell,
  Button,
  Center,
  Group,
  Loader,
  ThemeIcon,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  IconFileInvoice,
  IconLogout,
  IconMessageChatbot,
  IconMoon,
  IconSun,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import { LoginScreen } from './auth/LoginScreen';
import { AssistantChat } from './components/assistant/AssistantChat';
import { InvoicePanel } from './components/invoices/InvoicePanel';
import { ModelSwitcher } from './components/ModelSwitcher';
import { AssistantEngineSwitcher } from './components/AssistantEngineSwitcher';
import { useInvoiceSocket } from './hooks/useInvoiceSocket';
import { useAsideWidth } from './hooks/useAsideWidth';
import { InvoiceUIProvider } from './invoice-ui/InvoiceUIContext';
import { InvoiceModals } from './invoice-ui/InvoiceModals';
import type { Invoice } from './types/invoice';

export default function App() {
  const { status } = useAuth();

  if (status === 'checking') {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (status === 'unauthenticated') {
    return <LoginScreen />;
  }

  return <AuthedApp />;
}

function AuthedApp() {
  useInvoiceSocket(); // single subscription for the whole app

  const { logout } = useAuth();
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme('light');

  // Match the AppShell aside breakpoint ('md' ≈ 48em) so the overlay/collapse
  // logic and the JS "mobile" checks agree in the 48–62em band.
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [desktopOpened, { toggle: toggleDesktop }] = useDisclosure(true);
  const [mobileOpened, { toggle: toggleMobile }] = useDisclosure(false);
  const toggleAside = () => (isMobile ? toggleMobile() : toggleDesktop());

  // Resizable / expandable assistant panel. On mobile the Aside is an overlay,
  // so a fixed width is fine there; drag-resize only matters on desktop.
  const { width: asideWidth, expanded, startResize, toggleExpand, panelRef } =
    useAsideWidth();
  const asideOpen = isMobile ? mobileOpened : desktopOpened;

  // Delete confirmation target is owned here so both the panel and the
  // assistant can request a delete through the shared UI context.
  const [deleteTarget, setDeleteTarget] = useState<Invoice | null>(null);

  return (
    <InvoiceUIProvider onRequestDelete={setDeleteTarget}>
    <AppShell
      header={{ height: 56 }}
      aside={{
        // Mobile → full-width overlay (never wider than the viewport).
        // Expanded → fill the whole viewport. Otherwise the resizable width.
        width: isMobile ? '100vw' : expanded ? '100vw' : asideWidth,
        breakpoint: 'md',
        collapsed: { mobile: !mobileOpened, desktop: !desktopOpened },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <ThemeIcon
              variant="gradient"
              gradient={{ from: 'indigo', to: 'cyan' }}
              size="lg"
              radius="md"
              style={{ flexShrink: 0 }}
            >
              <IconFileInvoice size={20} />
            </ThemeIcon>
            <Title order={4} lineClamp={1} visibleFrom="xs">
              Invoice Processing
            </Title>
          </Group>
          <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
            {/* Engine/model selects need room for full model ids — show them only
                from md up; on smaller screens they live in the switcher's own
                responsive width and the user can still switch on a wider view. */}
            <Group gap="xs" wrap="nowrap" visibleFrom="md">
              <AssistantEngineSwitcher />
              <ModelSwitcher />
            </Group>
            <ActionIcon
              variant="default"
              size="lg"
              onClick={() =>
                setColorScheme(colorScheme === 'light' ? 'dark' : 'light')
              }
              aria-label="Toggle color scheme"
            >
              {colorScheme === 'light' ? <IconMoon size={18} /> : <IconSun size={18} />}
            </ActionIcon>
            {/* Assistant toggle: icon+label from sm up, icon-only on phones. */}
            <Button
              variant="light"
              leftSection={<IconMessageChatbot size={18} />}
              onClick={toggleAside}
              visibleFrom="sm"
            >
              Assistant
            </Button>
            <Tooltip label="Assistant">
              <ActionIcon
                variant="light"
                size="lg"
                onClick={toggleAside}
                aria-label="Toggle assistant"
                hiddenFrom="sm"
              >
                <IconMessageChatbot size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Sign out">
              <ActionIcon
                variant="default"
                size="lg"
                onClick={logout}
                aria-label="Sign out"
              >
                <IconLogout size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main className="app-surface">
        <InvoicePanel />
      </AppShell.Main>

      <AppShell.Aside
        ref={panelRef}
        p={0}
        className="assistant-aside"
        data-expanded={expanded || undefined}
      >
        {/* Inner wrapper is the positioning context for the resize handle —
            the Aside itself keeps Mantine's fixed positioning. */}
        <div style={{ position: 'relative', height: '100%' }}>
          {!isMobile && asideOpen && (
            <div
              onPointerDown={startResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize assistant panel"
              className="aside-resize-handle"
            />
          )}
          <AssistantChat
            expanded={expanded}
            onToggleExpand={isMobile ? undefined : toggleExpand}
            onClose={toggleAside}
          />
        </div>
      </AppShell.Aside>

      <InvoiceModals
        deleteTarget={deleteTarget}
        onCloseDelete={() => setDeleteTarget(null)}
      />
    </AppShell>
    </InvoiceUIProvider>
  );
}
