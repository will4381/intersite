// @ts-check
// A Worker wired the way the README shows; test/capture/workerd.test.mjs runs it in workerd.
import { createCapture } from "../../capture/index.mjs";

export default {
  /** @param {Request} request @param {{ COLLECTOR: string }} env @param {{ waitUntil(promise: Promise<unknown>): void }} ctx */
  async fetch(request, env, ctx) {
    const capture = createCapture({ project: "wd", url: env.COLLECTOR, token: "ingest", release: "r1", sample: 1 });
    const copy = request.clone();
    const response = Response.json({ note: { id: "note_abc12345", text: "stored" } }, { status: 201 });
    ctx.waitUntil(capture.record({ request: copy, response, route: "/notes", actor: { kind: "member" }, session: "user-7" }));
    return response;
  },
};
