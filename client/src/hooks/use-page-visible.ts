import { useEffect, useState } from "react";

/**
 * Tracks document.visibilityState. Use to gate `refetchInterval` so React
 * Query and setInterval-based timers don't burn cycles (and request quota)
 * while the tab is in the background.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}
