import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const REPOSITORY = "the-cursed-prince26/samt-releases";
export const CONTEXT = "samt/release-upload";
const marker = /<!-- samt-admin:v1\r?\n([\s\S]*?)\r?\n-->/;
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
    assert(String(draft.id) === id, "Release ID changed");
    assert(
      draft.draft && !draft.published_at && !draft.prerelease,
      "Release must remain a draft",
    );
    const match = draft.body?.match(marker);
    assert(match, "Missing managed preview");
    const envelope = JSON.parse(match[1]);
    assert(
      envelope.upload?.sha === commit &&
        envelope.upload?.ref === ref &&
        (envelope.release_id == null || envelope.release_id === id),
      "Session is not authorized by draft",
    );
    const preview = envelope.preview;
    assert(
      typeof preview?.tag === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(preview.tag) &&
        !preview.tag.startsWith("untagged-") &&
        !preview.tag.includes("..") &&
        !/\.$|\.lock$/.test(preview.tag) &&
        (preview.tag === draft.tag_name ||
          /^untagged-[a-f0-9]+$/.test(draft.tag_name)) &&
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
    assert(
      new Set(preview.packages.map((pkg) => pkg.platform)).size ===
        preview.packages.length,
      "Duplicate package platform",
    );
    for (const platform of ["android", "ios"]) {
      const policy = preview.manifest?.[platform];
      assert(
        policy &&
          Number.isSafeInteger(policy.latest_build) &&
          Number.isSafeInteger(policy.min_supported_build) &&
          policy.min_supported_build >= 1 &&
          policy.latest_build >= policy.min_supported_build &&
          typeof policy.force_update === "boolean" &&
          typeof policy.message === "string",
        "Invalid update policy",
      );
      const pkg = preview.packages.find((item) => item.platform === platform);
      const base = `https://github.com/${REPOSITORY}/releases`;
      if (pkg) {
        assert(
          pkg.app_id === "com.mhsous.samt" &&
            pkg.version === preview.version &&
            pkg.build === policy.latest_build &&
            pkg.filename
              .toLowerCase()
              .endsWith(platform === "android" ? ".apk" : ".ipa") &&
            policy.update_url ===
              `${base}/download/${encodeURIComponent(preview.tag)}/${encodeURIComponent(pkg.filename)}`,
          "Manifest does not target the approved package",
        );
      } else if (!(
        policy.latest_build === 1 &&
        policy.min_supported_build === 1 &&
        !policy.force_update &&
        policy.update_url === `${base}/latest`
      )) {
        assert(
          typeof policy.update_url === "string" &&
            policy.update_url.startsWith(`${base}/download/`),
          "Unchanged platform must target a release asset",
        );
        const url = new URL(policy.update_url);
        const parts = policy.update_url
          .slice(`${base}/download/`.length)
          .split("/");
        assert(
          parts.length === 2 &&
            parts.every(Boolean) &&
            !url.search &&
            !url.hash,
          "Invalid unchanged platform URL",
        );
        const release = await client.request(
          "GET",
          `/releases/tags/${encodeURIComponent(decodeURIComponent(parts[0]))}`,
        );
        const matches = release.assets?.filter(
          (asset) =>
            asset.name === decodeURIComponent(parts[1]) &&
            asset.state === "uploaded" &&
            asset.size > 0 &&
            /^sha256:[a-f0-9]{64}$/.test(asset.digest || ""),
        );
        assert(
          !release.draft &&
            !release.prerelease &&
            matches?.length === 1 &&
            matches[0].name
              .toLowerCase()
              .endsWith(platform === "android" ? ".apk" : ".ipa"),
          "Unchanged platform asset is unavailable",
        );
      }
    }
    assert(
      preview.packages.every((pkg) =>
        ["android", "ios"].includes(pkg.platform),
      ),
      "Invalid platform",
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
      const chunkSizes =
        pkg.chunk_sizes === undefined
          ? Array.from(
              { length: Math.ceil(pkg.size / (16 * 1024 ** 2)) },
              (_, part) =>
                Math.min(16 * 1024 ** 2, pkg.size - part * 16 * 1024 ** 2),
            )
          : pkg.chunk_sizes;
      assert(
        Array.isArray(pkg.chunks) &&
          Array.isArray(chunkSizes) &&
          pkg.chunks.length === chunkSizes.length &&
          chunkSizes.length <= Math.ceil(pkg.size / (4 * 1024 ** 2)) &&
          chunkSizes.every(
            (size) =>
              Number.isSafeInteger(size) && size > 0 && size <= 16 * 1024 ** 2,
          ) &&
          chunkSizes.reduce((sum, size) => sum + size, 0) === pkg.size,
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
              chunkEntry.size === chunkSizes[part],
            "Chunk is not in the approved upload tree",
          );
          const bytes = await client.request(
            "GET",
            `/git/blobs/${chunkSha}`,
            undefined,
            { raw: true },
          );
          const expectedLength = chunkSizes[part];
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
      String(current.id) === id &&
        current.draft &&
        !current.published_at &&
        !current.prerelease &&
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

export async function probePublicRelease(
  release,
  preview,
  { fetchImpl = fetch } = {},
) {
  const base = `https://github.com/${REPOSITORY}/releases`;
  const get = (url, headers = {}) =>
    fetchImpl(url, {
      headers: { "Cache-Control": "no-cache", ...headers },
      credentials: "omit",
      signal: AbortSignal.timeout(30000),
    });
  const response = await get(
    `${base}/latest/download/update.json?check=${Date.now()}`,
  );
  assert(response.status === 200, "Public update manifest is unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= 1024 * 1024, "Public manifest is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  assert(
    isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), preview.manifest),
    "Public Latest manifest is stale or differs from the approved preview",
  );
  const manifestAsset = release.assets?.find(
    (asset) => asset.name === "update.json",
  );
  assert(
    manifestAsset?.digest ===
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "Public manifest digest differs from the published asset",
  );
  for (const pkg of preview.packages) {
    assert(
      /^[A-Za-z0-9._-]+\.(apk|ipa)$/i.test(pkg.filename),
      "Invalid package filename",
    );
    const url = `${base}/download/${encodeURIComponent(preview.tag)}/${encodeURIComponent(pkg.filename)}`;
    assert(
      preview.manifest[pkg.platform]?.update_url === url,
      "Unexpected package URL",
    );
    const asset = release.assets?.filter((item) => item.name === pkg.filename);
    assert(
      asset?.length === 1 &&
        asset[0].state === "uploaded" &&
        asset[0].size === pkg.size &&
        asset[0].digest === `sha256:${pkg.sha256}`,
      "Published package differs from the preview",
    );
    const download = await get(url, { Range: "bytes=0-3" });
    try {
      assert(
        download.status === 206 &&
          download.headers.get("content-range") === `bytes 0-3/${pkg.size}` &&
          download.headers.get("content-length") === "4",
        "Public package range is unavailable or has the wrong size",
      );
      const prefix = new Uint8Array(await download.arrayBuffer());
      assert(
        prefix.length === 4 &&
          prefix[0] === 0x50 &&
          prefix[1] === 0x4b &&
          prefix[2] === 3 &&
          prefix[3] === 4,
        "Public package is not a ZIP archive",
      );
    } finally {
      if (download.body && !download.bodyUsed) await download.body.cancel();
    }
  }
}

export async function verifyPublishedRelease({
  client,
  payload,
  repository,
  probe = probePublicRelease,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert(repository === REPOSITORY, "Unexpected repository");
  const { commit, release_id: id, request_id: requestId } = payload || {};
  assert(
    validSha(commit) && /^\d+$/.test(id) && /^[a-f0-9-]{36}$/.test(requestId),
    "Invalid verification request",
  );
  const status = (state, description) =>
    client.request("POST", `/statuses/${commit}`, {
      state,
      context: `samt/release-public/${id}/${requestId}`,
      description,
    });
  try {
    await status("pending", "Checking anonymous release downloads");
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const release = await client.request("GET", `/releases/${id}`);
        const latest = await client.request("GET", "/releases/latest");
        const envelope = JSON.parse(release.body?.match(marker)?.[1] || "null");
        assert(
          !release.draft &&
            !release.prerelease &&
            release.published_at &&
            String(release.id) === id &&
            latest.id === release.id &&
            release.tag_name === envelope?.preview?.tag &&
            (envelope.upload?.sha === commit ||
              (!envelope.upload &&
                (await client.request("GET", "/commits/main")).sha === commit)),
          "Release identity or Latest changed",
        );
        await probe(release, envelope.preview);
        const current = await client.request("GET", "/releases/latest");
        assert(
          current.id === release.id &&
            current.tag_name === release.tag_name &&
            current.updated_at === release.updated_at,
          "Latest changed during public verification",
        );
        await status(
          "success",
          "Anonymous manifest and package downloads verified",
        );
        return;
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(5000 * (attempt + 1));
      }
    }
  } catch (error) {
    await status(
      "failure",
      "Published release downloads are not yet verified",
    ).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const run =
    event.action === "samt-release-public-v1"
      ? verifyPublishedRelease
      : assembleUpload;
  await run({
    client: new GitHubRunner(process.env.GITHUB_TOKEN),
    payload: event.client_payload,
    repository: process.env.GITHUB_REPOSITORY,
  });
}
