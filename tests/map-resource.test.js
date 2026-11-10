import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { validateMapResource } from "../server/map-resource.js";
import { sha256 } from "../server/security.js";

const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=", "base64");
const MINIMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

test("中国底图插槽只接受官方来源、有效审图号、原样声明和匹配摘要", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hh-map-test-"));
  try {
    assert.equal(validateMapResource(directory).status, "MISSING");
    const mapDirectory = path.join(directory, "maps");
    fs.mkdirSync(mapDirectory);
    const asset = VALID_PNG;
    fs.writeFileSync(path.join(mapDirectory, "china-original.png"), asset);
    const manifest = { reviewNumber: "GS(2026)1234号", sourceUrl: "https://bzdt.tianditu.gov.cn/example", assetFile: "china-original.png", sha256: sha256(asset), preserveOriginal: true, noCrop: true, noBoundaryModification: true, regionAnchors: [{ name: "测试省", xPercent: 50, yPercent: 40 }] };
    fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify(manifest));
    assert.deepEqual(validateMapResource(directory).regionAnchors, [{ name: "测试省", xPercent: 50, yPercent: 40 }]);
    const invalidBytes = randomBytes(64);
    fs.writeFileSync(path.join(mapDirectory, "china-original.png"), invalidBytes);
    fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify({ ...manifest, sha256: sha256(invalidBytes) }));
    assert.equal(validateMapResource(directory).status, "INVALID");
    fs.writeFileSync(path.join(mapDirectory, "renamed.jpg"), asset);
    fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify({ ...manifest, assetFile: "renamed.jpg" }));
    assert.equal(validateMapResource(directory).status, "INVALID");
    fs.writeFileSync(path.join(mapDirectory, "minimal.jpg"), MINIMAL_JPEG);
    fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify({ ...manifest, assetFile: "minimal.jpg", sha256: sha256(MINIMAL_JPEG) }));
    assert.equal(validateMapResource(directory).status, "READY");
    fs.writeFileSync(path.join(mapDirectory, "china-original.png"), asset);
    for (const regionAnchors of [
      "不是数组",
      [{ name: "测试省", xPercent: null, yPercent: 40 }],
      [{ name: "测试省", xPercent: -1, yPercent: 40 }],
      [{ name: "测试省", xPercent: 50, yPercent: 101 }],
      [{ name: "测试省", xPercent: 50, yPercent: 40 }, { name: "测试省", xPercent: 60, yPercent: 50 }]
    ]) {
      fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify({ ...manifest, regionAnchors }));
      assert.equal(validateMapResource(directory).status, "INVALID");
    }
    fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify({ ...manifest, sourceUrl: "https://example.invalid/map" }));
    assert.equal(validateMapResource(directory).status, "INVALID");
    fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    assert.equal(validateMapResource(directory).status, "INVALID");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
