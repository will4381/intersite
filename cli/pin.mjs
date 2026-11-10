// @ts-check
// `intersite pin <caseId> [--unpin]`: keeps a case past its expiry (or lets it expire again).
import { callCollector, SetupError } from "../collector/client.mjs";

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function pin(argv, { cwd }) {
  const unpin = argv.includes("--unpin");
  const rest = argv.filter((arg) => arg !== "--unpin");
  if (rest.length !== 1 || rest[0].startsWith("-")) {
    console.error("usage: intersite pin <caseId> [--unpin]");
    return 2;
  }
  const [id] = rest;
  try {
    const { project, status, body } = await callCollector(cwd, "POST", `/v1/cases/${encodeURIComponent(id)}/pin`, { pinned: !unpin });
    if (status === 404) {
      console.error(`case ${id} not found in project ${project}`);
      return 2;
    }
    if (status !== 200) throw new SetupError(`collector POST /v1/cases/:id/pin: ${status} ${body.error ?? ""}`.trim());
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    console.error(error.message);
    return 2;
  }
  console.log(`ok pin: ${id} ${unpin ? "unpinned" : "pinned"}`);
  return 0;
}
