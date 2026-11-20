import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "the-cursed-prince26/samt-releases";
export const CONTEXT = "samt/release-upload";
const marker = /<!-- samt-admin:v1\n([\s\S]*?)\n-->/;
const validSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export class GitHubRunner {
  constructor(
    token,
    {
      api = `https://api.github.com/repos/${REPOSITORY}`,
      uploads = `https://uploads.github.com/repos/${REPOSITORY}`,
    } = {},
  ) {
    this.token = token;
    this.api = api;
    this.uploads = uploads;
  }
  async request(method, path, body, { raw = false, file } = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: raw
        ? "application/vnd.github.raw+json"
        : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "samt-release-upload",
    };
    if (file) {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String((await stat(file)).size);
    } else if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch((file ? this.uploads : this.api) + path, {
      method,
      headers,
      ...(file
        ? { body: createReadStream(file), duplex: "half" }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(file ? 15 * 60 * 1000 : 120000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`GitHub ${method} failed (${response.status})`);
    if (raw) return Buffer.from(await response.arrayBuffer());
    return response.status === 204 ? null : response.json();
  }
}

export async function assembleUpload({ client, payload, repository }) {
  assert(repository === REPOSITORY, "Unexpected repository");
  const { commit, ref, release_id: id } = payload || {};
  assert(
    validSha(commit) &&
      /^\d+$/.test(id) &&
      typeof ref === "string" &&
      new RegExp(`^samt-upload/r${id}-[a-f0-9-]{36}$`).test(ref),
    "Invalid upload session",
  );
  const status = (state, description) =>
    client.request("POST", `/statuses/${commit}`, {
      state,
      context: CONTEXT,
      description,
    });
  const directory = await mkdtemp(join(tmpdir(), "samt-upload-"));
  try {
    await status("pending", "Checking and assembling release assets");
    const reference = await client.request("GET", `/git/ref/heads/${ref}`);
    assert(reference.object?.sha === commit, "Upload branch changed");
    const source = await client.request("GET", `/git/commits/${commit}`);
    assert(validSha(source.tree?.sha), "Invalid upload tree");
    const tree = await client.request(
      "GET",
      `/git/trees/${source.tree.sha}?recursive=1`,
    );
    assert(!tree.truncated, "Truncated upload tree");
    const entry = tree.tree?.find(
      (item) => item.path === "session.json" && item.type === "blob",
    );
    assert(
      entry && entry.size <= 65536 && validSha(entry.sha),
      "Invalid session metadata",
    );
    const raw = await client.request(
      "GET",
      `/git/blobs/${entry.sha}`,
      undefined,
      { raw: true },
    );
    assert(raw.length <= 65536, "Oversized session metadata");
    const session = JSON.parse(raw.toString("utf8"));
    const draft = await client.request("GET", `/releases/${id}`);
    assert(draft.draft && !draft.prerelease, "Release must remain a draft");
    const match = draft.body?.match(marker);
    assert(match, "Missing managed preview");
    const envelope = JSON.parse(match[1]);
    assert(
      envelope.upload?.sha === commit && envelope.upload?.ref === ref,
      "Session is not authorized by draft",
    );
    const preview = envelope.preview;
    assert(
      preview?.tag === draft.tag_name &&
        session.version === 1 &&
        session.release_id === id &&
        session.preview_id === preview.preview_id,
      "Upload does not match approved preview",
    );
    assert(
      Array.isArray(preview.packages) &&
        preview.packages.length >= 1 &&
        preview.packages.length <= 2 &&
        Array.isArray(session.packages) &&
        session.packages.length === preview.packages.length,
      "Invalid package count",
    );
    const paths = new Map(tree.tree.map((item) => [item.path, item]));
    const files = [];
    for (let index = 0; index < session.packages.length; index++) {
      const pkg = session.packages[index],
        expected = preview.packages[index];
      assert(
        pkg.filename === expected.filename &&
          /^[A-Za-z0-9._-]+\.(apk|ipa)$/i.test(pkg.filename) &&
          pkg.size === expected.size &&
          Number.isSafeInteger(pkg.size) &&
          pkg.size > 0 &&
          pkg.size < 2 * 1024 ** 3 &&
          pkg.sha256 === expected.sha256 &&
          /^[a-f0-9]{64}$/.test(pkg.sha256),
        "Package differs from approved preview",
      );
      assert(
        Array.isArray(pkg.chunks) &&
          pkg.chunks.length === Math.ceil(pkg.size / (16 * 1024 ** 2)),
        "Invalid chunk count",
      );
      const file = join(directory, String(index));
      const handle = await open(file, "wx");
      const hash = createHash("sha256");
      let length = 0;
      try {
        for (let part = 0; part < pkg.chunks.length; part++) {
          const chunkSha = pkg.chunks[part];
          const chunkEntry = paths.get(`chunks/${index}/${part}`);
          assert(
            validSha(chunkSha) &&
              chunkEntry?.type === "blob" &&
              chunkEntry.sha === chunkSha &&
              chunkEntry.size <= 16 * 1024 ** 2,
            "Chunk is not in the approved upload tree",
          );
          const bytes = await client.request(
            "GET",
            `/git/blobs/${chunkSha}`,
            undefined,
            { raw: true },
          );
          const expectedLength = Math.min(16 * 1024 ** 2, pkg.size - length);
          assert(bytes.length === expectedLength, "Invalid chunk length");
          const blobHash = createHash("sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex");
          assert(blobHash === chunkSha, "Chunk hash mismatch");
          hash.update(bytes);
          await handle.writeFile(bytes);
          length += bytes.length;
        }
      } finally {
        await handle.close();
      }
      assert(
        length === pkg.size && hash.digest("hex") === pkg.sha256,
        "Package SHA-256 mismatch",
      );
      files.push({
        file,
        filename: pkg.filename,
        size: pkg.size,
        sha256: pkg.sha256,
      });
    }
    assert(
      new Set(files.map((file) => file.filename)).size === files.length,
      "Duplicate filenames",
    );
    // Derive update.json from the approved draft, not from a client-supplied URL.
    const manifest = JSON.stringify(preview.manifest, null, 2);
    assert(
      manifest && Buffer.byteLength(manifest) <= 65536,
      "Invalid update manifest",
    );
    const manifestPath = join(directory, "manifest");
    const manifestHandle = await open(manifestPath, "wx");
    try {
      await manifestHandle.writeFile(manifest);
    } finally {
      await manifestHandle.close();
    }
    files.push({
      file: manifestPath,
      filename: "update.json",
      size: Buffer.byteLength(manifest),
      sha256: createHash("sha256").update(manifest).digest("hex"),
    });
    // Recheck authorization after the potentially long download, before writes.
    const current = await client.request("GET", `/releases/${id}`);
    assert(
      current.draft &&
        current.body === draft.body &&
        current.tag_name === draft.tag_name,
      "Draft changed during assembly",
    );
    const assets = await client.request(
      "GET",
      `/releases/${id}/assets?per_page=100`,
    );
    for (const expected of files) {
      const existing = assets.filter(
        (asset) => asset.name === expected.filename,
      );
      if (existing.length) {
        assert(
          existing.length === 1 &&
            existing[0].state === "uploaded" &&
            existing[0].size === expected.size &&
            existing[0].digest === `sha256:${expected.sha256}`,
          "Existing asset differs; refusing to overwrite it",
        );
        continue;
      }
      const uploaded = await client.request(
        "POST",
        `/releases/${id}/assets?name=${encodeURIComponent(expected.filename)}`,
        undefined,
        { file: expected.file },
      );
      assert(
        uploaded.state === "uploaded" &&
          uploaded.name === expected.filename &&
          uploaded.size === expected.size &&
          uploaded.digest === `sha256:${expected.sha256}`,
        "Uploaded asset verification failed",
      );
    }
    await status("success", "Release assets uploaded and verified");
  } catch (error) {
    await status("failure", "Upload failed; draft was not published").catch(
      () => {},
    );
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  await assembleUpload({
    client: new GitHubRunner(process.env.GITHUB_TOKEN),
    payload: event.client_payload,
    repository: process.env.GITHUB_REPOSITORY,
  });
}
