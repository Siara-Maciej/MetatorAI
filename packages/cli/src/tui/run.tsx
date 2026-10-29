import { render } from "ink";
import { App, type Exit, type Kept } from "./App.tsx";
import type { TuiService } from "./service.ts";

const ALT_SCREEN_ON = "\x1b[?1049h\x1b[H";
const ALT_SCREEN_OFF = "\x1b[?1049l";

/**
 * `metator ui` (G5, ADR-0060): the full-screen view on the alternate screen, so the person's
 * terminal comes back as it was. A program that needs the terminal (a terminal editor, a shell,
 * `git diff`) gets it; the view comes back afterwards where it was.
 */
export async function runTui(
  service: TuiService,
  io: { readonly write: (text: string) => void; readonly refreshMs?: number },
): Promise<{ readonly visited: readonly string[] }> {
  let kept: Kept | undefined;
  for (;;) {
    let exit: Exit | undefined;
    io.write(ALT_SCREEN_ON);
    const app = render(
      <App
        service={service}
        {...(kept ? { kept } : {})}
        {...(io.refreshMs ? { refreshMs: io.refreshMs } : {})}
        bell={() => io.write("\x07")}
        onExit={(e) => {
          exit = e;
        }}
      />,
      // The screen goes to stderr: stdout carries only the one JSON envelope (MT-CODE-004).
      // `metator ui` starts only in a terminal, so it is interactive even where CI is set (Ink would
      // otherwise draw only the last frame).
      { exitOnCtrlC: true, stdout: process.stderr, interactive: Boolean(process.stderr.isTTY) },
    );
    await app.waitUntilExit();
    io.write(ALT_SCREEN_OFF);
    const done = exit as Exit | undefined;
    if (!done || done.kind === "quit") return { visited: done?.visited ?? kept?.visited ?? [] };
    const r = await service.launch(done.launch);
    kept = done.state;
    if (r) io.write(`${r}\n`);
  }
}
