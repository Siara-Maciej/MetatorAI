import { existsSync } from "node:fs";

/** Whether a program of that name is on PATH (or, given a path, is a program there). */
export const onPath = (command: string): boolean => Bun.which(command) !== null;

/** Whether a program can be started: a path that exists, or a name found on PATH. */
export const commandExists = (command: string): boolean =>
  command.includes("/") ? existsSync(command) : onPath(command);

/** Whether an absolute path is there at all: a file or a directory. */
export const pathExists = (path: string): boolean => existsSync(path);
