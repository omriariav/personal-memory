import type { Catalog } from "./catalog.js";

export class LanceCatalog {
  static async open(opts: { slot: string; dir: string }): Promise<Catalog> {
    throw new Error(`index slot '${opts.slot}' (${opts.dir}) is a new-format slot — this build cannot read it yet`);
  }
}
