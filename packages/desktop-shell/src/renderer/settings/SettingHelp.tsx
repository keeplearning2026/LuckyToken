import { useId, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

export function SettingHelp({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const id = useId();
  return <span className="setting-help">
    <button type="button" className="setting-help-trigger" aria-label={`${label} help`} aria-describedby={id}>
      <CircleHelp size={15} aria-hidden="true" />
    </button>
    <span className="setting-help-content" id={id} role="tooltip">{children}</span>
  </span>;
}
