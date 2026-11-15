import { readFile, writeFile, mkdir, unlink, access } from "node:fs/promises";
const action = process.argv[2],
  file = ".cache/local-ui-fixture.json";
if (!["start", "start-empty", "start-operational", "cleanup", "recover"].includes(action))
  throw new Error(
    "Use start, start-empty, start-operational <fictional-source.json>, cleanup or recover; local fictional data only.",
  );
if (action.startsWith("start")) {
  const exists = await access(file).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new Error(
      "Existing fixture is preserved; cleanup before creating another.",
    );
}
const text = await readFile("infra/.dev.vars", "utf8"),
  token = text.match(/^POC_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("Local POC_TOKEN is missing.");
const body = action === "start-operational"
  ? JSON.parse(await readFile(process.argv[3],"utf8"))
  : !action.startsWith("start")
  ? { fixtureId: JSON.parse(await readFile(file, "utf8")).fixtureId }
  : { profile: action === "start-empty" ? "empty" : "configured" };
const response = await fetch(
  "http://localhost:8787/__local/" +
    (action === "start-operational" ? "operational-fixture" : action.startsWith("start") ? "fixture" : action),
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(action === "start-operational" ? 120_000 : 30_000),
  },
);
if (!response.ok)
  throw new Error("Local fixture request failed: " + response.status);
if (action.startsWith("start")) {
  await mkdir(".cache", { recursive: true });
  await writeFile(file, JSON.stringify(await response.json()), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    "Created fictional fixture. Credentials saved only in ignored .cache/local-ui-fixture.json.",
  );
} else if (action === "cleanup") {
  await unlink(file);
  console.log(
    "Disabled fixture accounts, removed sessions and credentials; local evidence data retained.",
  );
} else {
  console.log(
    "Re-delivered owned local fixture jobs through their existing fences.",
  );
}
