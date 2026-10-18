// The server's installation, session and registration rules, as the tests'
// server (NotTennaPod-Server internal/api: successor, authentication and
// session; PROTOCOL §5). One browser's cookie jar: a request carries the
// cookie the browser holds when it is sent, and an answer's Set-Cookie takes
// effect when the answer arrives. Answers to chosen paths can be held, and let
// go in any order.
//
// - A successor registration names a new installation: the credential's own
//   installation is refused (400 invalid_request).
// - With the same nonce the authorizing installation is superseded; a
//   superseded installation may only repeat its handoff (to the same
//   successor), read its session or sign out; other requests get 409
//   installation_superseded.
// - A repeat of a registration replaces the successor's earlier credential:
//   the cookie the first answer gave is revoked (401).
// - The successor's first use of its credential revokes its predecessor's.

interface Installation {
  nonce: string;
  createdFrom?: string;
  supersededBy?: string;
  pendingPredecessor?: string;
}

export class FakeServer {
  readonly account: string;
  readonly installations = new Map<string, Installation>();
  readonly credentials = new Map<string, { install: string; revoked: boolean }>();
  /** jar is the browser's session cookie. */
  jar: string | null = null;
  /** registrations are the successful successor registrations, in order. */
  readonly registrations: string[] = [];
  /** unauthorized counts the requests answered 401. */
  unauthorized = 0;
  /** hold names the paths whose answers wait until let go. */
  readonly hold = new Set<string>();
  readonly held: { path: string; deliver: () => void }[] = [];
  #next = 0;

  constructor(account: string, install_id: string, nonce: string) {
    this.account = account;
    this.installations.set(install_id, { nonce });
    this.jar = this.#issue(install_id);
  }

  #issue(install: string): string {
    const cookie = `session-${++this.#next}`;
    this.credentials.set(cookie, { install, revoked: false });
    return cookie;
  }

  #revokeOf(install: string): void {
    for (const c of this.credentials.values()) if (c.install === install) c.revoked = true;
  }

  /** authenticate is the server's check of the cookie a request carries: the error it answers, or the installation it authenticates. */
  #authenticate(cookie: string | null, path: string): { status: number; error: string } | { install: string } {
    const cred = cookie ? this.credentials.get(cookie) : undefined;
    if (!cred || cred.revoked) {
      this.unauthorized++;
      return { status: 401, error: "unauthorized" };
    }
    const inst = this.installations.get(cred.install)!;
    const successor = path === "/v1/installations/successor";
    if (inst.supersededBy && !successor && path !== "/v1/session") return { status: 409, error: "installation_superseded" };
    if (inst.pendingPredecessor && !successor) {
      this.#revokeOf(inst.pendingPredecessor);
      delete inst.pendingPredecessor;
    }
    return { install: cred.install };
  }

  #successor(old: string, body: { install_id: string; instance_nonce: string }): { status: number; error?: string; cookie?: string } {
    if (body.install_id === old) return { status: 400, error: "invalid_request" };
    const authorizing = this.installations.get(old)!;
    if (authorizing.supersededBy && authorizing.supersededBy !== body.install_id) return { status: 409, error: "installation_superseded" };
    const existing = this.installations.get(body.install_id);
    if (!existing) {
      this.installations.set(body.install_id, { nonce: body.instance_nonce, createdFrom: old });
      if (body.instance_nonce === authorizing.nonce) {
        authorizing.supersededBy = body.install_id;
        this.installations.get(body.install_id)!.pendingPredecessor = old;
      }
    } else if (existing.createdFrom !== old || existing.nonce !== body.instance_nonce) {
      return { status: 409, error: "installation_conflict" };
    } else {
      this.#revokeOf(body.install_id); // a repeated handoff replaces the successor's earlier credential
    }
    this.registrations.push(body.install_id);
    return { status: 200, cookie: this.#issue(body.install_id) };
  }

  /**
   * answer is the server's answer to a request sent now, with the browser's
   * cookie at this moment; `other` answers the paths these rules leave to the test.
   */
  answer(path: string, body: Record<string, any>, other: (path: string, body: Record<string, any>) => unknown): Promise<Response> {
    const sent = this.jar;
    const who = this.#authenticate(sent, path);
    let status = 200;
    let out: unknown = {};
    let cookie: string | undefined;
    if ("status" in who) {
      status = who.status;
      out = { error: who.error, message: who.error };
    } else if (path === "/v1/installations/successor") {
      const r = this.#successor(who.install, body as { install_id: string; instance_nonce: string });
      status = r.status;
      cookie = r.cookie;
      out = r.error ? { error: r.error, message: r.error } : { install_id: body.install_id };
    } else if (path === "/v1/session") {
      out = {
        account: { account_id: this.account, namespace: "n", username: "u", is_admin: false },
        install_id: who.install,
        superseded_by: this.installations.get(who.install)!.supersededBy ?? null,
      };
    } else {
      out = other(path, body);
    }
    const respond = () => {
      if (cookie) this.jar = cookie; // Set-Cookie, as the answer arrives
      return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
    };
    if (!this.hold.has(path)) return Promise.resolve(respond());
    return new Promise((resolve) => this.held.push({ path, deliver: () => resolve(respond()) }));
  }

  /** release lets the held answers arrive, the latest first when `reversed`. */
  release(reversed = false): void {
    const all = this.held.splice(0);
    for (const h of reversed ? all.reverse() : all) h.deliver();
  }
}
