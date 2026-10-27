import { readFileSync } from "node:fs";
import { defineLoader } from "vitepress";

/** Command groups and their commands, read from the generated reference (site/api/commands.md). */
export interface CommandGroup {
  group: string;
  commands: { name: string; summary: string }[];
}

declare const data: CommandGroup[];

export { data };

export default defineLoader({
  watch: ["../../api/commands.md"],
  load([file]: string[]): CommandGroup[] {
    const groups: CommandGroup[] = [];
    const lines = readFileSync(file as string, "utf8").split("\n");
    lines.forEach((line, i) => {
      const group = /^## (\S+)$/.exec(line)?.[1];
      if (group) groups.push({ group, commands: [] });
      const name = /^### `metator (.+)`$/.exec(line)?.[1];
      if (name)
        groups.at(-1)?.commands.push({
          name,
          summary: (lines[i + 2] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
        });
    });
    return groups;
  },
});
