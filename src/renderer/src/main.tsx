import React from "react";
import ReactDOM from "react-dom/client";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";
import App from "./App";
import { AppDataProvider } from "./state/AppDataProvider";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppDataProvider>
      <App />
    </AppDataProvider>
  </React.StrictMode>,
);
