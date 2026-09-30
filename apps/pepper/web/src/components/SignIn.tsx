import * as React from 'react';
import { api, ApiRequestError, UNAUTHORIZED_EVENT } from '@/lib/api';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorNote,
  Field,
  Input,
  Spinner,
} from '@/components/ui';

interface Session {
  required: boolean;
  authenticated: boolean;
}

/**
 * Renders the app only once the server says this browser may use it.
 *
 * The server sets a session cookie in exchange for the API token (see
 * server/src/auth.ts), so this screen is seen once per browser per month.
 * Any 401 later — the token was rotated, the cookie expired — brings it back
 * via `UNAUTHORIZED_EVENT` rather than leaving every screen showing errors.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<'checking' | 'ok' | 'sign-in'>('checking');

  React.useEffect(() => {
    api
      .get<Session>('/v1/session')
      .then((session) => setState(session.authenticated ? 'ok' : 'sign-in'))
      // A server too old to know /v1/session has no auth either.
      .catch(() => setState('ok'));

    const onUnauthorized = () => setState('sign-in');
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  return state === 'ok' ? <>{children}</> : <SignIn />;
}

function SignIn() {
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.post('/v1/session', { token });
      // A full reload rather than flipping state: every screen's data
      // requests failed while signed out and would otherwise stay failed.
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiRequestError && err.status === 401 ? 'That token is not valid.' : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Pepper</CardTitle>
          <CardDescription>This server needs its API token (PEPPER_API_TOKEN).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="API token">
              <Input
                type="password"
                autoComplete="current-password"
                autoFocus
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" disabled={busy || !token.trim()}>
              {busy ? <Spinner /> : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
