import { icons, type IconName, type IconPath } from "../generated/icons.ts";

/** Icon draws one of Android AntennaPod's icons in the current text colour. */
export function Icon({ name, size = 24, label }: { name: IconName; size?: number; label?: string }) {
  const icon = icons[name];
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox={icon.viewBox}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      focusable="false"
    >
      {(icon.paths as IconPath[]).map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill}
          stroke={p.stroke}
          stroke-width={p.strokeWidth}
          fill-rule={p.fillRule as "evenodd" | undefined}
          opacity={p.opacity}
          transform={p.transform}
        />
      ))}
    </svg>
  );
}
