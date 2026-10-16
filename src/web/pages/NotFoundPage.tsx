import { Link } from "react-router";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

export function NotFoundPage() {
  useDocumentTitle("Not found");
  return (
    <div className="card">
      <h1>Not found</h1>
      <p className="muted">
        That page does not exist. <Link to="/">Go home</Link>.
      </p>
    </div>
  );
}
