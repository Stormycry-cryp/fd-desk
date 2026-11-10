import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { boot } from "./api/client"
import { App } from "./App"
import "./styles/tokens.css"
import "./styles/components.css"
import "./styles/data.css"
import "./styles/layout.css"
import "./styles/pages.css"

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30000, refetchOnWindowFocus: false } } })

boot().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  ),
)
