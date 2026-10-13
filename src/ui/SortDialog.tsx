// Android's ItemSortDialog: each order a row whose button picks it, a second
// press reversing its direction; the selected one shows its arrow.
import { useEffect, useRef } from "preact/hooks";
import { t, type StringKey } from "../i18n.ts";
import { Icon } from "./Icon.tsx";

export interface SortOption {
  label: StringKey;
  ascending: string;
  descending: string;
  ascendingIsDefault: boolean;
}

export const dateOption: SortOption = { label: "date", ascending: "date_old_new", descending: "date_new_old", ascendingIsDefault: false };
export const durationOption: SortOption = { label: "duration", ascending: "duration_short_long", descending: "duration_long_short", ascendingIsDefault: true };
export const titleOption: SortOption = { label: "episode_title", ascending: "episode_title_a_z", descending: "episode_title_z_a", ascendingIsDefault: true };

export function SortDialog({ options, value, onChange, onClose, children }: {
  options: SortOption[];
  value: string;
  onChange: (order: string) => void;
  onClose: () => void;
  children?: preact.ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} class="dialog sort-dialog" onCancel={onClose} onClose={onClose} aria-labelledby="sort-title">
      <h2 id="sort-title">{t("sort")}</h2>
      <div class="sort-options">
        {options.map((o) => {
          const selected = value === o.ascending || value === o.descending;
          const next = !selected ? (o.ascendingIsDefault ? o.ascending : o.descending) : value === o.ascending ? o.descending : o.ascending;
          return (
            <button key={o.label} class={`sort-option${selected ? " selected" : ""}`} aria-pressed={selected} onClick={() => onChange(next)}>
              {t(o.label)}
              {selected && o.ascending !== o.descending && <Icon name={value === o.ascending ? "arrow_full_up" : "arrow_full_down"} size={18} />}
            </button>
          );
        })}
      </div>
      {children}
      <div class="dialog-buttons">
        <button class="text-button" onClick={onClose}>
          {t("close_label")}
        </button>
      </div>
    </dialog>
  );
}
