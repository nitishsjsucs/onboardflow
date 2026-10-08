import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function Placeholder() {
  return <main><h1>OnboardFlow</h1></main>;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Placeholder />
    </StrictMode>,
  );
}
