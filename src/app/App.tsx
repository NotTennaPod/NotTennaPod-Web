// The app: boot (session, installation, author), then the shell and the
// screen of the current route. Another tab's sign-in or sign-out reloads this
// one (PROTOCOL §12).
import { useEffect, useState } from "preact/hooks";
import { w } from "../i18n.ts";
import { get, handlers } from "../api/http.ts";
import { boot, onAccountTransition, signOut, type BootResult } from "./boot.ts";
import { SyncContext } from "./context.ts";
import { useRoute, type Route } from "./router.ts";
import { Sync } from "./sync.ts";
import { Shell } from "../ui/Shell.tsx";
import { Empty, Loading } from "../ui/components.tsx";
import { SignIn } from "../screens/SignIn.tsx";
import { Home } from "../screens/Home.tsx";
import { Episodes, Favorites, History, Inbox, Queue } from "../screens/Lists.tsx";
import { Subscriptions } from "../screens/Subscriptions.tsx";
import { Podcast } from "../screens/Podcast.tsx";
import { Episode } from "../screens/Episode.tsx";
import { Statistics } from "../screens/Statistics.tsx";
import { AddPodcast } from "../screens/AddPodcast.tsx";
import { Settings } from "../screens/Settings.tsx";
import { leavePlayer, startPlayer, stopPlayer } from "../player/instance.ts";
import { RecoveryKeyDialog } from "../ui/RecoveryKeyDialog.tsx";
import { detach as detachImport } from "./importJob.ts";
import { offerState, recoveryKeySaved, setOffer, settleOffer } from "../ui/recoveryKey.ts";

/**
 * RecoveryKeyOffer offers to save the recovery key once after setup in this
 * browser (PROTOCOL §11.1): to an administrator, while the server has none.
 * "Not now" ends the offer; Settings keeps the action and its warning.
 */
function RecoveryKeyOffer({ sync }: { sync: Sync }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (offerState() !== "pending" || !sync.session.account.is_admin) return;
    let live = true;
    get<{ keys_exported_at: number }>("/v1/admin/service").then(
      (r) => live && setOpen(settleOffer(true, r.keys_exported_at ?? 0)),
      () => {}, // asked again at the next page load
    );
    return () => {
      live = false;
    };
  }, [sync]);
  if (!open) return null;
  return (
    <RecoveryKeyDialog
      offer
      onClose={() => {
        setOffer("done");
        setOpen(false);
      }}
      onSaved={() => {
        setOpen(false);
        recoveryKeySaved(sync);
      }}
    />
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <Home />;
    case "queue":
      return <Queue />;
    case "inbox":
      return <Inbox />;
    case "subscriptions":
      return <Subscriptions />;
    case "episodes":
      return <Episodes />;
    case "history":
      return <History />;
    case "favorites":
      return <Favorites />;
    case "statistics":
      return <Statistics />;
    case "add":
      return <AddPodcast />;
    case "settings":
      return <Settings />;
    case "podcast":
      // One podcast per screen: another podcast (Back, Forward, a link) starts a new one, so nothing
      // open on the last one (its dialogs, its selection) carries over.
      return <Podcast key={route.id} id={route.id} />;
    case "episode":
      return <Episode id={route.id} />;
    default:
      return <Empty icon="questionmark" title={w("not_found_title")} text="" />;
  }
}

/** current is the signed-in account's Sync, whose player an account transition stops first. */
let current: Sync | undefined;
let leaving = false;

/** reloadAfterLeaving reloads the tab for an account transition once the player has made its last save. */
function reloadAfterLeaving(): void {
  if (leaving) return;
  leaving = true;
  // The import's job stops without a word, its unload prompt with it: the reload is the account's.
  detachImport();
  void leavePlayer(current).finally(() => location.reload());
}

export function App() {
  const [state, setState] = useState<BootResult | "loading" | "unreachable">("loading");
  const [sync, setSync] = useState<Sync>();
  const route = useRoute();
  const start = () => {
    setState("loading");
    boot().then(
      async (r) => {
        if (r.kind === "conflict") {
          // The session belongs to another installation: end it, then log in afresh.
          await signOut().catch(() => {});
          setState({ kind: "signed_out", setupRequired: false, reason: w("installation_conflict") });
          return;
        }
        setState(r);
        if (r.kind === "signed_in") {
          const s = new Sync(r.session);
          current = s;
          // From now on a refused session or another account reloads the tab, after the player's last save.
          handlers({ accountChanged: () => reloadAfterLeaving(), signedOut: () => reloadAfterLeaving() });
          // The player first exports what an earlier page load left, then loads the current episode paused (PROTOCOL §12).
          startPlayer(s);
          setSync(s);
        }
      },
      () => {
        setState("unreachable");
        setTimeout(start, 5000);
      },
    );
  };
  useEffect(() => {
    start();
    return onAccountTransition(() => reloadAfterLeaving());
  }, []);
  useEffect(() => sync?.start(), [sync]);
  useEffect(() => (sync ? () => stopPlayer(sync) : undefined), [sync]);
  if (state === "loading") return <Loading />;
  if (state === "unreachable") {
    return (
      <div class="banner" role="alert">
        {w("server_unreachable")}
      </div>
    );
  }
  if (state.kind === "signed_out") return <SignIn setup={state.setupRequired} reason={state.reason} onDone={start} />;
  if (state.kind === "conflict") return <Loading />;
  if (!sync) return <Loading />;
  return (
    <SyncContext.Provider value={sync}>
      <Shell route={route}>
        <Screen route={route} />
      </Shell>
      <RecoveryKeyOffer sync={sync} />
    </SyncContext.Provider>
  );
}
