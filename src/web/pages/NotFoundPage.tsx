import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="card">
      <h1>Not found</h1>
      <p className="muted">
        That page does not exist. <Link to="/">Go home</Link>.
      </p>
    </div>
  );
}
