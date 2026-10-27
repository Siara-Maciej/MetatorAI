import type { PortProbe } from "@metator/core";
import getPort from "get-port";

/**
 * PortProbe on get-port (ADR-0050): the port is free when get-port hands out exactly it. get-port
 * checks every local interface, IPv6 included; on a host without IPv6 that check throws, so the
 * probe falls back to all IPv4 interfaces.
 */
export class GetPortProbe implements PortProbe {
  async isFree(port: number): Promise<boolean> {
    try {
      return (await getPort({ port })) === port;
    } catch {
      return (await getPort({ port, host: "0.0.0.0" })) === port;
    }
  }
}
