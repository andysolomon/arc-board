import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface AsyncButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  busy: boolean;
  onClick: () => void | Promise<void>;
  loadingLabel?: ReactNode;
  spinnerClassName?: string;
  children: ReactNode;
}

export function AsyncButton({
  busy,
  onClick,
  loadingLabel,
  spinnerClassName = "sq-merge-phase__spinner",
  children,
  disabled,
  className,
  type = "button",
  ...rest
}: AsyncButtonProps) {
  const classes = ["sq-async-btn", className].filter(Boolean).join(" ");

  return (
    <button
      type={type}
      className={classes}
      disabled={busy || disabled}
      onClick={() => {
        if (busy) return;
        void onClick();
      }}
      {...rest}
    >
      {busy && <span className={spinnerClassName} aria-hidden />}
      {busy && loadingLabel != null ? loadingLabel : children}
    </button>
  );
}
