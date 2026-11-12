import { err, type HealthProbe, type HealthTarget, MetatorError, ok, type Result } from "@metator/core";

/**
 * HealthProbe on wait-on (ADR-0053): TCP accepts a connection, HTTP answers 2xx to a GET (wait-on's
 * plain `http://` would send HEAD, which many dev servers do not answer).
 */
export class WaitOnHealthProbe implements HealthProbe {
  async waitFor(target: HealthTarget, timeoutMs: number): Promise<Result<void, MetatorError>> {
    const resource =
      "tcp" in target
        ? `tcp:${target.tcp.host}:${target.tcp.port}`
        : target.http.replace(/^http(s?):\/\//, "http$1-get://");
    try {
      // Loaded when a probe runs: the import costs every command about 0.2 s of start otherwise.
      const { default: waitOn } = await import("wait-on");
      await waitOn({
        resources: [resource],
        timeout: timeoutMs,
        interval: 200,
        tcpTimeout: 1000,
        httpTimeout: 2000,
      });
      return ok(undefined);
    } catch (e) {
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `${"tcp" in target ? resource : target.http} was not ready: ${(e as Error).message}`,
        ),
      );
    }
  }
}
