/**
 * Errors are values. We use neverthrow's Result/ResultAsync (ADR-0011) instead of a home-grown type:
 * domain and application code return `Result`, only adapters at the edge translate exceptions.
 */
export { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
