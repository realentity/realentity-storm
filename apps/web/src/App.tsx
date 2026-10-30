import { useEffect, useState } from "react";

type Health = "checking" | "ok" | "down";

/** Placeholder shell until M3 (login, pipelines, inbox). Shows whether the api and database are reachable. */
export function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((response) => setHealth(response.ok ? "ok" : "down"))
      .catch(() => setHealth("down"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>AI ME</h1>
      <p>API: {health}</p>
    </main>
  );
}
