/**
 * Class names joined (clsx) with conflicting Tailwind utilities resolved, the last one winning
 * (tailwind-merge): the one way a component of `ui/` combines its classes with a caller's.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
