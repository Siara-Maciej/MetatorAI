/**
 * The answers that promise the person's own words: `Other` is the answer itself, `Reject` goes
 * back to the run with its reason. Every other label (Approve, Allow, Deny, a listed option) is
 * a whole answer on its own. One rule for the terminal, the full-screen view and the app.
 */
export const ANSWERS_WITH_WORDS: readonly string[] = ["Reject", "Other"];

/** Whether the chosen labels ask for the person's own words too. */
export const needsWords = (choices: readonly string[]): boolean =>
  choices.some((c) => ANSWERS_WITH_WORDS.includes(c));

/** Whether the words may be left empty: a reason may, the answer itself (`Other`) may not. */
export const wordsRequired = (choices: readonly string[]): boolean => choices.includes("Other");

/**
 * A question's options with `needsText` on the ones that ask for words, for a client that shows
 * the question without MetatorAI's code (the app reads it as data). Nothing else changes.
 */
export function withNeedsText<Q extends { readonly options: readonly { readonly label: string }[] }>(
  question: Q,
): Q {
  return {
    ...question,
    options: question.options.map((o) => (needsWords([o.label]) ? { ...o, needsText: true } : o)),
  };
}
