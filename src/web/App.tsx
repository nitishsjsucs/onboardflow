import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { RouterProvider } from "react-router";
import { SessionProvider } from "./auth/session.tsx";
import { createAppRouter } from "./router.tsx";

export function App() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } } }));
  const [router] = useState(() => createAppRouter());
  return (
    <QueryClientProvider client={client}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  );
}
