import { describe, expect, test } from "bun:test";
import { taskWarnings } from "@metator/core";

describe("taskWarnings", () => {
  test("a clear task, and a work item reference, leave nothing open", () => {
    expect(taskWarnings("Add a --json flag to `status` that prints the overview as JSON")).toEqual([]);
    expect(taskWarnings("#123")).toEqual([]);
    expect(taskWarnings("PAY-42")).toEqual([]);
    expect(taskWarnings("https://github.com/a/b/issues/7")).toEqual([]);
  });

  test("too short a task, a question left in it, a placeholder: each said once", () => {
    expect(taskWarnings("fix it")).toEqual([
      "task: 2 word(s): say what should change and how you will know it works, or the intake asks",
    ]);
    expect(
      taskWarnings(
        "Add a timeout option to pEvent. Should it reject or resolve with undefined? Default TBD.",
      ),
    ).toEqual([
      "task: it asks a question (Should it reject or resolve with undefined?): decide it in the task, or the run asks you back",
      'task: "TBD" leaves a part undecided: fill it in, or the run asks you back',
    ]);
    expect(taskWarnings("Pick a name? Or a number?\nThen ship it to users now")[0]).toBe(
      "task: it asks 2 questions (Pick a name?): decide it in the task, or the run asks you back",
    );
    expect(taskWarnings("Return ??? when the input is empty, as the docs say")).toEqual([
      'task: "???" leaves a part undecided: fill it in, or the run asks you back',
    ]);
  });
});
