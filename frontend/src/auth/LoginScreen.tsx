import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Center,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconFileInvoice } from '@tabler/icons-react';
import axios from 'axios';
import { apiErrorMessage } from '../lib/api';
import { useAuth } from './AuthProvider';

export function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = username.trim().length > 0 && password.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || loading) return;
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(
        axios.isAxiosError(err) && err.response?.status === 401
          ? 'Invalid username or password.'
          : apiErrorMessage(err),
      );
      setLoading(false);
    }
  };

  return (
    <Center h="100vh" p="md" className="app-surface">
      <Stack align="center" gap="lg" w={400} maw="100%">
        <Stack align="center" gap={6}>
          <ThemeIcon
            variant="gradient"
            gradient={{ from: 'indigo', to: 'cyan' }}
            size={64}
            radius="lg"
          >
            <IconFileInvoice size={34} />
          </ThemeIcon>
          <Title order={2} mt="xs">
            Invoice Processing
          </Title>
          <Text size="sm" c="dimmed" ta="center">
            Upload, track and chat about your invoices
          </Text>
        </Stack>

        <Paper withBorder shadow="md" p="xl" radius="lg" w="100%">
          <form onSubmit={submit}>
            <Stack gap="md">
              {error && (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} radius="md">
                  {error}
                </Alert>
              )}

              <TextInput
                label="Username"
                placeholder="Your username"
                size="md"
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                autoFocus
                autoComplete="username"
              />
              <PasswordInput
                label="Password"
                placeholder="Your password"
                size="md"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                autoComplete="current-password"
              />
              <Button
                type="submit"
                fullWidth
                size="md"
                mt="xs"
                loading={loading}
                disabled={!canSubmit}
                variant="gradient"
                gradient={{ from: 'indigo', to: 'cyan' }}
              >
                Sign in
              </Button>
            </Stack>
          </form>
        </Paper>
      </Stack>
    </Center>
  );
}
