// A tiny observable value: what a screen follows with useValue.

type Listener = () => void;

/** A tiny observable value. */
export class Value<T> {
  #v: T;
  #ls = new Set<Listener>();
  constructor(v: T) {
    this.#v = v;
  }
  get(): T {
    return this.#v;
  }
  set(v: T): void {
    if (Object.is(v, this.#v)) return;
    this.#v = v;
    for (const l of [...this.#ls]) l();
  }
  subscribe(l: Listener): () => void {
    this.#ls.add(l);
    return () => this.#ls.delete(l);
  }
}
