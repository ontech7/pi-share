import '../styles.css';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '../ui/Toaster.tsx';
import { App } from './App.tsx';
import { ApiError, keys } from './api.ts';

const onError = (error: Error) => {
  if (error instanceof ApiError && error.status === 401) queryClient.invalidateQueries({ queryKey: keys.session });
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Toaster>
        <App />
      </Toaster>
    </QueryClientProvider>
  </StrictMode>,
);
