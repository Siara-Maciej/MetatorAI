/**
 * An error in one screen (ADR-0109): the screen's place says what went wrong and offers to try
 * again, while the shell and the sidebar go on. A new route starts the screen over.
 */

import type { ReactNode } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Button } from "../ui/button.tsx";

function ScreenFailed({ error, resetErrorBoundary }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="screen-failed panel" role="alert" data-testid="screen-failed">
      <h2>This screen stopped</h2>
      <p className="muted">
        Something in the app went wrong while it drew this screen. The rest of the app still works.
      </p>
      <pre className="mono dim">{message}</pre>
      <Button variant="primary" onClick={resetErrorBoundary}>
        Try again
      </Button>
    </div>
  );
}

export function ScreenBoundary({
  place,
  children,
}: {
  readonly place: string;
  readonly children: ReactNode;
}) {
  return (
    <ErrorBoundary FallbackComponent={ScreenFailed} resetKeys={[place]}>
      {children}
    </ErrorBoundary>
  );
}
