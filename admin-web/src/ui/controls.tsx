import { cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { Button, cn } from "@clinica/calendar";

export const inputClass =
  "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-text-4 focus-visible:border-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft disabled:cursor-not-allowed disabled:bg-subtle disabled:text-text-3 aria-[invalid=true]:border-danger";

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn(inputClass, "pr-7", className)}>
      {children}
    </select>
  );
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(inputClass, "h-auto min-h-[4.5rem] py-2", className)} />;
}

/**
 * Etiqueta + control + ayuda/error. La etiqueta ENVUELVE al control, así que sirve
 * para cualquier input y los lectores de pantalla la asocian sin ids.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  // La ayuda y el error se enlazan al control (aria-describedby / aria-invalid) para los lectores de pantalla.
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, { "aria-describedby": hint || error ? id : undefined, "aria-invalid": error ? true : undefined })
    : children;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="flex flex-col gap-1 text-[13px] font-semibold text-text-2">
        {label}
        {control}
      </label>
      {(hint || error) && (
        <p id={id} role={error ? "alert" : undefined} className={cn("text-xs", error ? "font-medium text-danger-text" : "text-text-3")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Checkbox({ label, hint, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string; hint?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 text-sm", className)}>
      <input type="checkbox" {...props} className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-[var(--accent)]" />
      <span>
        {label}
        {hint && <span className="block text-xs text-text-3">{hint}</span>}
      </span>
    </label>
  );
}

/** Un error que bloquea el envío del formulario, con `role="alert"`. */
export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm font-medium text-danger-text">
      {children}
    </p>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: "info" | "warn" | "ok"; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "info" && "border-border bg-subtle text-text-2",
        tone === "warn" && "border-warning-soft bg-warning-tint text-warning-text",
        tone === "ok" && "border-success-soft bg-success-tint text-success-text",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "danger" | "brand"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold",
        tone === "neutral" && "bg-secondary text-text-2",
        tone === "ok" && "bg-success-tint text-success-text",
        tone === "warn" && "bg-warning-tint text-warning-text",
        tone === "danger" && "bg-danger-tint text-danger-text",
        tone === "brand" && "bg-brand-tint text-brand-text"
      )}
    >
      {children}
    </span>
  );
}

/** Botón que se bloquea y muestra un giro mientras `busy` (evita el doble envío). */
export function BusyButton({ busy, children, disabled, ...props }: React.ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button {...props} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}

export const dangerButton = "bg-danger text-white hover:bg-danger-text";

export function Spinner({ label = "Cargando" }: { label?: string }) {
  return <span role="status" aria-label={label} className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-brand" />;
}

export function PageMessage({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {children && <div className="text-sm text-text-2">{children}</div>}
      {action}
    </div>
  );
}
