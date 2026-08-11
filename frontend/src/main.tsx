import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import "./theme/tokens.css";
import "./index.css";

export function mount(container: Element): void {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

const container = document.getElementById("root");
if (container === null) {
  // Failing here is far better than a blank page with a clean console.
  throw new Error("Syl admin could not start: index.html has no #root element.");
}
mount(container);
