import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { FeedbackProvider } from "./hooks/useFeedback";
import { SettingsProvider } from "./hooks/useSettings";
import { I18nProvider } from "./hooks/useI18n";
import { AppErrorBoundary } from "./components/ErrorBoundary";

window.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  { capture: true }
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FeedbackProvider>
      <SettingsProvider>
        <I18nProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </I18nProvider>
      </SettingsProvider>
    </FeedbackProvider>
  </React.StrictMode>
);

