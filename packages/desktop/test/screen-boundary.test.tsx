/**
 * An error in one screen stays in that screen (ADR-0109): its place shows what went wrong with
 * Try again, and a new route starts the screen over.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ScreenBoundary } from "../src/app/screen-boundary.tsx";

let broken = true;
const Screen = () => {
  if (broken) throw new Error("the plan has no steps");
  return <p>the screen</p>;
};

describe("a screen that throws", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("shows the panel in its place; Try again and a new route draw it again", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    const root = createRoot(host, { onCaughtError: () => {} });
    const draw = (place: string) =>
      act(() =>
        root.render(
          <main>
            <span>the shell</span>
            <ScreenBoundary place={place}>
              <Screen />
            </ScreenBoundary>
          </main>,
        ),
      );
    draw("#/run/r1");
    expect(host.querySelector('[data-testid="screen-failed"]')?.textContent).toContain(
      "the plan has no steps",
    );
    expect(host.textContent).toContain("the shell");
    // Try again draws the screen again.
    broken = false;
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(host.textContent).toContain("the screen");
    // It fails again; another route starts the screen over.
    broken = true;
    draw("#/run/r1/changes");
    broken = false;
    draw("#/run/r1/changes");
    expect(host.querySelector('[data-testid="screen-failed"]')).not.toBeNull();
    draw("#/inbox");
    expect(host.textContent).toContain("the screen");
    act(() => root.unmount());
  });
});
