import { useQuery } from '@tanstack/react-query';
import { Route, Switch } from 'wouter';
import { detectLang } from '../lib/i18n.ts';
import { I18nProvider } from '../lib/i18n-context.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { api, keys } from './api.ts';
import { Shell } from './Shell.tsx';
import { LinkScreen } from './screens/LinkScreen.tsx';
import { LinksScreen } from './screens/LinksScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { SetupScreen } from './screens/SetupScreen.tsx';

export function App() {
  const session = useQuery({ queryKey: keys.session, queryFn: api.session });
  const lang = detectLang(session.data?.lang || undefined);
  document.documentElement.lang = lang;

  return (
    <I18nProvider lang={lang}>
      {!session.data ? (
        <div className="grid min-h-dvh place-items-center text-muted">
          <Spinner className="size-6" />
        </div>
      ) : session.data.needsSetup ? (
        <SetupScreen />
      ) : !session.data.authenticated ? (
        <LoginScreen />
      ) : (
        <Shell>
          <Switch>
            <Route path="/links/:id">{(params) => <LinkScreen id={params.id} />}</Route>
            <Route path="/settings/:section?">{(params) => <SettingsScreen section={params.section} />}</Route>
            <Route>
              <LinksScreen />
            </Route>
          </Switch>
        </Shell>
      )}
    </I18nProvider>
  );
}
