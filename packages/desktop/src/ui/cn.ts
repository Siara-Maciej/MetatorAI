/**
 * Class names joined (clsx) with conflicting Tailwind utilities resolved, the last one winning
 * (tailwind-merge): the one way a component of `ui/` combines its classes with a caller's.
 */
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The design system's utilities carry the prefix `tw:` (ui/theme.css). */
const twMerge = extendTailwindMerge({ prefix: "tw" });

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
