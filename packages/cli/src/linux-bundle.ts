/**
 * The portable Linux CLI bundle (ADR-0105): the compiled `metator` for Linux (glibc) with what it
 * cannot hold (`metator-resources`, see installation.ts) and a launcher, in one folder per
 * architecture, shipped as one tarball. It works wherever it is unpacked: the Windows and macOS
 * apps carry it to copy into a Dev Container and run the daemon there. `scripts/linux-cli-bundle.ts`
 * builds it from these; the app finds it by its manifest, a versioned document (ADR-0016).
 *
 *   metator-linux-<arch>/
 *     bin/metator                  the launcher (POSIX sh): checks the machine, names the resources
 *     libexec/metator              the executable
 *     libexec/metator-resources/   native addons, node-pty, the sandbox runtime, the canon
 */

export type LinuxArch = "x64" | "arm64";

/** The manifest's kind; it sits beside the tarball as `metator-bundle.json`. */
export const BUNDLE_KIND = "LinuxCliBundle";
const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_MANIFEST = "metator-bundle.json";

/** The architecture as the bundle names it, from Node's (`x64`), Docker's (`amd64`) or `uname -m`'s (`aarch64`) name. */
export function linuxArch(name: string): LinuxArch | undefined {
  const n = name.trim().toLowerCase();
  if (n === "x64" || n === "x86_64" || n === "amd64") return "x64";
  if (n === "arm64" || n === "aarch64") return "arm64";
  return undefined;
}

/** Where everything is, relative to the folder the tarball is unpacked in. */
export function bundleLayout(arch: LinuxArch): {
  readonly root: string;
  readonly launcher: string;
  readonly executable: string;
  readonly resources: string;
  readonly tarball: string;
  readonly triple: string;
} {
  const root = `metator-linux-${arch}`;
  return {
    root,
    launcher: `${root}/bin/metator`,
    executable: `${root}/libexec/metator`,
    resources: `${root}/libexec/metator-resources`,
    tarball: `${root}.tar.gz`,
    triple: arch === "x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu",
  };
}

export interface BundleManifest {
  readonly kind: typeof BUNDLE_KIND;
  readonly schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  /** The CLI's version (`metator version`), the app's too. */
  readonly version: string;
  readonly platform: "linux";
  readonly libc: "glibc";
  /** The oldest glibc that runs it: the newest symbol version its programs and addons ask for. */
  readonly glibc: string;
  readonly arch: LinuxArch;
  /** The tarball's file name, beside the manifest. */
  readonly tarball: string;
  /** The launcher, relative to where the tarball is unpacked. */
  readonly entry: string;
  /** The tarball's SHA-256: a copy in a container is checked against it. */
  readonly sha256: string;
}

export function bundleManifest(o: {
  readonly arch: LinuxArch;
  readonly version: string;
  readonly sha256: string;
  readonly glibc: string;
}): BundleManifest {
  const l = bundleLayout(o.arch);
  return {
    kind: BUNDLE_KIND,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    version: o.version,
    platform: "linux",
    libc: "glibc",
    glibc: o.glibc,
    arch: o.arch,
    tarball: l.tarball,
    entry: l.launcher,
    sha256: o.sha256,
  };
}

/**
 * The oldest glibc that runs these programs: the newest `GLIBC_x.y` symbol version in their
 * dynamic symbol tables (`objdump -T` of each); undefined when none asks for one.
 */
export function glibcFloor(objdumps: readonly string[]): string | undefined {
  let floor: [number, number] | undefined;
  for (const text of objdumps)
    for (const m of text.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
      const v: [number, number] = [Number(m[1]), Number(m[2])];
      if (!floor || v[0] > floor[0] || (v[0] === floor[0] && v[1] > floor[1])) floor = v;
    }
  return floor ? `${floor[0]}.${floor[1]}` : undefined;
}

/** The glibc dynamic loader of each architecture: without it the executable cannot start (musl, Alpine). */
const LOADER: Record<LinuxArch, string> = {
  x64: "/lib64/ld-linux-x86-64.so.2",
  arm64: "/lib/ld-linux-aarch64.so.1",
};

/**
 * The launcher, `bin/metator`: it finds the bundle from its own path (through a link to it, as
 * from /usr/local/bin), says plainly when the machine cannot run it (another architecture, no
 * glibc), and starts the executable with its resources named. `check` replaces the machine's
 * answers in tests.
 */
export function linuxLauncher(
  arch: LinuxArch,
  check: {
    readonly machine?: string;
    readonly loader?: string;
    /** The oldest glibc the bundle runs on (`glibcFloor`); unchecked when not given. */
    readonly glibc?: string;
    /** What says the machine's glibc version (`glibc 2.36`). */
    readonly libc?: string;
  } = {},
): string {
  const accepted = arch === "x64" ? "x86_64|amd64" : "aarch64|arm64";
  const loader = check.loader ?? LOADER[arch];
  const [needMajor, needMinor] = (check.glibc ?? "").split(".");
  // getconf says `glibc 2.36`; a machine without it is not refused (the loader said glibc).
  const version =
    check.glibc === undefined
      ? []
      : [
          `have=$(${check.libc ?? "getconf GNU_LIBC_VERSION 2>/dev/null"} | sed 's/^glibc //')`,
          `major=$(echo "$have" | cut -d. -f1); minor=$(echo "$have" | cut -d. -f2)`,
          'case "$major$minor" in',
          "  ''|*[!0-9]*) ;;",
          `  *) if [ "$major" -lt ${needMajor} ] || { [ "$major" -eq ${needMajor} ] && [ "$minor" -lt ${needMinor} ]; }; then`,
          `       echo "metator: this bundle needs glibc ${check.glibc} or newer; this Linux has $have. Use an image with a newer glibc." >&2`,
          "       exit 126",
          "     fi ;;",
          "esac",
        ];
  return [
    "#!/bin/sh",
    `# MetatorAI CLI for Linux ${arch} (glibc), from the portable bundle (ADR-0105).`,
    'self=$(readlink -f -- "$0" 2>/dev/null || printf \'%s\' "$0")',
    'root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)',
    `machine=$(${check.machine ?? "uname -m"})`,
    'case "$machine" in',
    `  ${accepted}) ;;`,
    `  *) echo "metator: this bundle is for ${arch} Linux; this machine is $machine. Use the bundle for its architecture." >&2; exit 126 ;;`,
    "esac",
    `if [ ! -e ${loader} ]; then`,
    `  echo "metator: this Linux has no glibc (${loader} is missing; Alpine and other musl systems are not supported). Use a glibc image (Debian, Ubuntu, Fedora...)." >&2`,
    "  exit 126",
    "fi",
    ...version,
    'METATOR_RESOURCES="$root/libexec/metator-resources"',
    "export METATOR_RESOURCES",
    'exec "$root/libexec/metator" "$@"',
    "",
  ].join("\n");
}
