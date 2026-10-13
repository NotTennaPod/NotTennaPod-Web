// Statistics (Android's StatisticsFragment): the Subscriptions tab (played
// time per podcast with the "include marked as played" setting and date
// range) and the Years tab (played time per month), and Reset statistics
// data. Download statistics stay on devices.
import { useState } from "preact/hooks";
import { t, plural } from "../i18n.ts";
import { reads } from "../api/views.ts";
import * as act from "../app/actions.ts";
import { useSync } from "../app/context.ts";
import { linkProps, pathOf } from "../app/router.ts";
import { useView } from "../app/useView.ts";
import { Cover } from "../ui/Cover.tsx";
import { Confirm, Loading, Menu, Toolbar } from "../ui/components.tsx";
import { Icon } from "../ui/Icon.tsx";
import { formatAbbrev } from "../ui/format.ts";
import { useLocalSetting } from "../ui/settings.ts";
import { exportBeforeCut } from "../player/instance.ts";

function hm(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${plural("time_hours_quantified", h)} ${plural("time_minutes_quantified", m)}` : plural("time_minutes_quantified", m);
}

export function Statistics() {
  const sync = useSync();
  const [tab, setTab] = useState<"subscriptions" | "years">("subscriptions");
  const [marked, setMarked] = useLocalSetting("statistics_include_marked", "false");
  const [confirm, setConfirm] = useState(false);
  const view = useView((signal) => reads.statistics({ include_marked: marked }, signal), [marked]);
  const s = view.data;
  const reset = async () => {
    if (!s) return;
    // The cut observes exactly the view's past (PROTOCOL §12); unexported saves are exported first (PROTOCOL §12).
    const listening = await exportBeforeCut(sync);
    const { frontier } = await reads.frontier(s.head.cursor);
    await sync.act(act.statisticsReset([...frontier, ...listening]));
    setConfirm(false);
  };
  const maxMonth = Math.max(1, ...(s?.months.map((m) => m.played_ms) ?? [1]));
  return (
    <section>
      <Toolbar title={t("statistics_label")}>
        <Menu
          label={t("filter")}
          icon={<Icon name="filter" />}
          items={[{ label: t("statistics_include_marked"), checked: marked === "true", run: () => setMarked(marked === "true" ? "false" : "true") }]}
        />
        <Menu label={t("overflow_more")} items={[{ label: t("statistics_reset_data"), run: () => setConfirm(true) }]} />
      </Toolbar>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "subscriptions"} onClick={() => setTab("subscriptions")}>
          {t("subscriptions_label")}
        </button>
        <button role="tab" aria-selected={tab === "years"} onClick={() => setTab("years")}>
          {t("years_statistics_label")}
        </button>
      </div>
      {!s ? (
        <Loading />
      ) : tab === "subscriptions" ? (
        <div role="tabpanel">
          <p class="statistics-total" dir="auto">
            <strong>{hm(s.played_ms)}</strong>
            <br />
            {marked === "true" ? t("statistics_counting_total") : t("statistics_counting_range", formatAbbrev(s.oldest_date), formatAbbrev(Date.now()))}
          </p>
          <p class="secondary statistics-notice">{t("statistics_speed_not_counted")}</p>
          <ul class="statistics-list">
            {s.podcasts.map((r) => (
              <li key={r.podcast!.podcast_id}>
                <a {...linkProps(pathOf({ name: "podcast", id: r.podcast!.podcast_id }))}>
                  <Cover url={r.podcast!.image_url} title={r.podcast!.display_title ?? ""} size={40} />
                  <span class="statistics-title">{r.podcast!.display_title}</span>
                  <span class="statistics-value" dir="auto">{hm(marked === "true" ? r.played_marked_ms : r.played_ms)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div role="tabpanel">
          <ul class="years-list">
            {s.months.map((m) => (
              <li key={`${m.year}-${m.month}`}>
                <span>{new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short" }).format(new Date(m.year, m.month - 1, 1))}</span>
                <span class="bar" style={{ width: `${(m.played_ms / maxMonth) * 100}%` }} />
                <span>{hm(m.played_ms)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {confirm && <Confirm title={t("statistics_reset_data")} message={t("statistics_reset_data_msg")} onCancel={() => setConfirm(false)} onConfirm={reset} />}
    </section>
  );
}
