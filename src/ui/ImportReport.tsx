// The server's import report (PROTOCOL §11.5): what was imported, and every podcast or
// episode skipped, merged or left unmatched, with its reason.
import { w } from "../i18n.ts";
import { web, type WebKey } from "../webStrings.ts";

interface Entry {
  kind?: string;
  reason?: string;
  podcast?: string;
  title: string;
}

export interface ImportResult {
  imported: { podcasts: number; episodes: number; queue: number; favorites: number; history: number; inbox: number };
  skipped: Entry[] | null;
  ambiguous: Entry[] | null;
  merged: Entry[] | null;
}

export interface ImportStatus {
  import_id: string;
  kind: string;
  file_name?: string;
  status: string;
  reason?: string;
  result?: ImportResult;
}

function reason(r: string): string {
  const key = `import_reason_${r}`;
  return key in web ? w(key as WebKey) : r.replace(/_/g, " ");
}

function Entries({ title, entries }: { title: WebKey; entries: Entry[] | null | undefined }) {
  if (!entries?.length) return null;
  return (
    <details class="import-entries">
      <summary>
        {w(title)} ({entries.length})
      </summary>
      <ul>
        {entries.map((e, i) => (
          <li key={i} dir="auto">
            {e.podcast ? `${e.podcast}: ` : ""}
            {e.title}
            {e.reason ? ` (${reason(e.reason)})` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ImportReport({ status }: { status: ImportStatus }) {
  const what = status.kind === "opml" ? w("import_kind_opml") : w("import_kind_android_db");
  const r = status.result;
  return (
    <div class="import-report" role="status">
      <p>
        {status.status === "published"
          ? w("import_status_published", what)
          : status.status === "failed"
            ? w("import_status_failed", what, status.reason ?? "")
            : w("import_status_running", what)}
      </p>
      {r && (
        <>
          <p>
            {w(
              "import_imported",
              String(r.imported.podcasts),
              String(r.imported.episodes),
              String(r.imported.queue),
              String(r.imported.favorites),
              String(r.imported.history),
              String(r.imported.inbox),
            )}
          </p>
          <Entries title="import_skipped" entries={r.skipped} />
          <Entries title="import_merged" entries={r.merged} />
          <Entries title="import_ambiguous" entries={r.ambiguous} />
        </>
      )}
    </div>
  );
}
