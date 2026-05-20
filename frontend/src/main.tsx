import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, toast } from "react-hot-toast";
import { configureApi, ErrorBoundary } from "@chongbei/web-basics/client";
import "./index.css";
import { AuthBoot } from "./components/AuthBoot";

// -----------------------------------------------------------------------------
// App startup wiring for @chongbei/web-basics on the client:
//   - configureApi injects our toast lib. All `api<T>()` calls in
//     lib/portfolioClient.ts and lib/priceClient.ts route their failures
//     through this, so users always see "(Ref: abc123)" and we never fail
//     silently (CLAUDE.md rule 10).
//   - <ErrorBoundary> wraps <App/> so a thrown render error shows a visible
//     fallback instead of a blank screen (rule 10).
//   - <Toaster/> renders the actual toast surface.
// -----------------------------------------------------------------------------

configureApi({
  toast: {
    error: (m) => toast.error(m),
    warn: (m) => toast(m, { icon: "⚠️" }),
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthBoot />
      <Toaster position="top-right" />
    </ErrorBoundary>
  </StrictMode>,
);
