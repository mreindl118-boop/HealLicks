import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { connect, installLifecycleHandlers } from "./ws-client.js";
import "./styles.css";

connect();
installLifecycleHandlers();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
