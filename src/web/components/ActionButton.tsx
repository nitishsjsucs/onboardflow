// A button for a row's or card's own action. While `busy` (its request is in
// flight, or the server is still running what it started) it is
// aria-disabled instead of disabled: Chromium moves focus from a button that
// turns disabled to <body>, so a keyboard user would lose their place, and
// after a failure a second Enter would do nothing. A click while busy is
// ignored here; useItemAction also refuses a second run while one is in
// flight. `disabled` stays for a button that cannot be used yet (an empty
// reason, an invalid value).
import type { ButtonHTMLAttributes, Ref } from "react";

export type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; ref?: Ref<HTMLButtonElement> };

export function ActionButton({ busy = false, onClick, type = "button", ref, ...rest }: ActionButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-disabled={busy || undefined}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    />
  );
}
