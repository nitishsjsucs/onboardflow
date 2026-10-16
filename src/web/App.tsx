import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { RouterProvider } from "react-router";
import { createQueryClient } from "./api/query-client.ts";
import { SessionProvider } from "./auth/session.tsx";
import { createAppRouter } from "./router.tsx";

export function App() {
  const [client] = useState(() => createQueryClient());
  const [router] = useState(() => createAppRouter());
  return (
    <QueryClientProvider client={client}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  );
}
