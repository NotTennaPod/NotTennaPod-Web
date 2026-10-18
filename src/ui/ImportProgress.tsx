// The account's import as the tab's job follows it (PROTOCOL §11.5): reading
// and sending the file, the server's import, the report, and the first
// refresh of the imported podcasts; an interrupted upload with its Cancel; a
// damaged or foreign-chunked one with Start again. Add podcast and Settings
// show the same job.
import { useEffect, useState } from "preact/hooks";
import { w } from "../i18n.ts";
import * as job from "../app/importJob.ts";
import { Confirm } from "./components.tsx";
import { noticeText, progressLine } from "./importText.ts";
import { ImportReport, type ImportStatus } from "./ImportReport.tsx";

/** useImportJob attaches to the tab's import job and follows it. */
export function useImportJob(): job.JobView {
  const [view, setView] = useState(job.snapshot());
  useEffect(() => {
    const off = job.subscribe(() => setView(job.snapshot()));
    job.attach();
    setView(job.snapshot());
    return off;
  }, []);
  return view;
}

/** ImportProgress shows the tab's import job; it renders nothing while there is none. */
export function ImportProgress({ view }: { view: job.JobView }) {
  const [confirm, setConfirm] = useState(false);
  const s = view.state;
  const line = progressLine(s);
  const im = "im" in s ? s.im : undefined;
  const report: ImportStatus | undefined = s.k === "published" || s.k === "failed" ? (s.im as ImportStatus) : undefined;
  const cancellable = (s.k === "uploading" && !s.legacy) || (s.k === "interrupted" && !s.legacy) || s.k === "mismatch";
  const restart = s.k === "mismatch" && job.canRestart();
  return (
    <>
      {(line || view.notice || view.waiting) && (
        <div class="import-progress" role="status">
          {view.notice && (
            <p class={view.notice.n === "error" || view.notice.n === "wrong_file" ? "error" : undefined} dir="auto">
              {noticeText(view.notice)}
            </p>
          )}
          {line && <p dir="auto">{line.text}</p>}
          {line?.bar && <progress value={line.max ? line.value : undefined} max={line.max || undefined} aria-label={line.text} />}
          {s.k === "interrupted" && s.legacy && <p dir="auto">{w("import_legacy_cancel")}</p>}
          {view.waiting && <p class="secondary">{w("import_waiting")}</p>}
        </div>
      )}
      {(cancellable || restart) && (
        <div class="import-actions">
          {restart && (
            <button type="button" class="filled-button" onClick={() => job.cancel(true)}>
              {w("import_start_again")}
            </button>
          )}
          {cancellable && (
            <button type="button" class="outlined-button" onClick={() => setConfirm(true)}>
              {w("import_cancel")}
            </button>
          )}
        </div>
      )}
      {report && <ImportReport status={report} />}
      {confirm && im && (
        <Confirm
          title={w("import_cancel")}
          message={w("import_cancel_message", im.file_name)}
          confirm={w("import_cancel")}
          dismiss={w("import_keep")}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            job.cancel();
          }}
        />
      )}
    </>
  );
}
