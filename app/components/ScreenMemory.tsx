import { useEffect } from "react";
import { useLocation } from "react-router";

import { rememberScreen } from "../lib/feedback/feedback-ui";

/**
 * Keeps the screen a merchant is on, so Feedback can say where a problem was (#743).
 * Renders nothing; lives in the app layout so it sees every navigation.
 */
export function ScreenMemory() {
  const { pathname } = useLocation();
  useEffect(() => rememberScreen(pathname), [pathname]);
  return null;
}
