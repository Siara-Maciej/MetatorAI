/**
 * The app's button (ADR-0111): every button of the app is this one. A variant is a class the
 * stylesheet draws (`primary`, `ghost`, `danger`), so a look changes in one place; the default
 * `type` is `button`, never an accidental submit.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export const buttonVariants = cva("", {
  variants: {
    variant: {
      default: "",
      primary: "primary",
      ghost: "ghost",
      danger: "danger",
    },
  },
  defaultVariants: { variant: "default" },
});

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ variant, className, type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant }), className) || undefined} {...props} />
  );
}
