#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_SVG = resolve(REPOSITORY_ROOT, "artifacts/ratp-network-native.svg");
const DEFAULT_JSON = resolve(REPOSITORY_ROOT, "artifacts/ratp-network-native.json");
const EXPECTED_VIEW_BOX = [0, 0, 1133.86, 1133.86];
const EXPECTED_STATIONS = 390;
const LEGACY_EXPECTED_INTERSTATIONS = 484;
const WATER_COLOR = "#BBE3FA";
// Canonical d/transform/paint signatures of the 53 unsplit Metro/RER paths in
// PLAN_PARIS_SCHEMATIQUE_SANS_CARROYAGE_01_2026. Split fragments cannot match
// these signatures. Terminal artwork is separately allowed by its native
// decoration class/group.
const MONOLITHIC_ROUTE_SIGNATURES = new Set(`
92c515e0995f00f087a004d66b435b7b24031f33d64ec7f89a51e829d0af5aa9
85e6e9f9729ca765e80aa2ed1f28030bd70f686b5c9ce4551954fa93ffb34d3e
071475792ed0c5f4ba3cef530aa2bd954b4e531703b3b7903fdd572b25a71395
4774c550d9de46b8b75baca439916bd84fcc33ba7ced2619ebcd47a4e5a47000
14941b45e5d43af750ff0a74bb31422cd94dd3502695efd2f61dad6f772c4838
1adc16c12c45c88393859fe4969f473862a0b8fe16b2e1edec3ea21f1b32d8f5
093dc864173339488b805d0a6e68f48c59f65b464cd588e2ec0e3c1ea056c365
92ac4f903aee97d06e3f72a1007411999d40aec6fc58e4dad3053aa9d5322818
ef4f6189cf4ccbbb3f5fcff0f1e3d11f6b025505ab1fc41a4f3bb6fb0d80b465
a41f2ac70d3919dca0fbaee5b0d8f097ae1f1582f46580cb1db81904d64312fd
8ea3727e242644a0a5cab3751512395a6b3d803146d345b0b07c129d03477d7c
79df9a212f2df955a04ec432d3cd62aabba82e3dfb4d14aa8a87b549e6e14e16
e9ac15fe4998af446fe6de1326d07d0b932bf7624e62e55a070c2034f67cef20
403db5c9742a765d5d5c7c25152b162286f85dae32884937de0e5373a0751b6f
f1ade08f56e0350e4cdcfe1afa09c004d3afb36a5ea2065b2f431ab90f0268b1
e2e19cf9e7555212f7ad6d123a00e7619e2a5874651a73281ffdee41393d496e
6bfa9fd0aba800032aa4389de2f98d5d9f9b4e4b698c089aed7b8e742949a6de
ea2cccef8ac4134fefab78b26c361d04b89519bae65623af9dd36a6347e87529
90276823b09b7f33937b384c35af5333d1e9402317d759f59c2a3775fef05d02
137850da5b38daab58a5ebae966f49d256b642e2775650259efd9d41e914a78a
041ee0547b52d00afcabd468814eb3007149ce720707669d0ecd6b7f1310e1ce
74232811aac1b5feb4431c81c55013436851eae30d33d46bc87968106fb6afaa
44f003c5f4c3e727f93c3e78d8238339c3d1ba9cf972ad88cb8dca69f6402785
d56ed2158c67ff780174320a044ec612a0a1f69f0876f55df1072a5254b05bc0
cf57afaf0eb17bae97f75b281471e3b6eef46766ea5aa4672b54c7ab68b5cc46
f741959d60daf920ed2d53fe2a7351311031160a56abce6c3227f75767cb63b1
385a60f7e764d3fdc6e71c4143dfb5247609cb5e0cb845b9d22f2392530ba62e
956988515c089e4b9f3e8b17a24f1925a29ec661ad6f5311936409506e4fd4e4
620a750424a36092a7e91a88d62f3c7781cc89c0d80668f2bf3f3694e5fe6fed
e3f9e164730fb268b15d0824dc234f6684fe7bae3954d755e54297cecc9f4a0d
7de3bb9df687bdd1d10520d306a7205e34931f8cb791e19ebca6a46d39973ad8
0468d6719dc1b7ac47b40e7652e59e2ba1fbba60e7eeb3a0a82f61d372a6a615
4425fec50b50495a6acee57cccee0f4d0eeee6fd3fbdb054cf3f316266dfb7ec
ee33c04de1e7c75985434ca52af6b5b0973d5d693f625bddd29b008ee6fc160d
19a50e1d7c377df62751f4c5fefb3e6e675090211b0e0b9886bc734048b0b1cd
91dd441852fe5d146ad55511d2cccb7d081eea99281832d3fa7fca0321af0503
327ff189702548b402d92e33b526a08e527bfe3f0e3378bbb987b22b117055ae
afaa3a52916d242e4dd154381223e692d50cece2d644d00494cdea953db930e7
2937a643f4d046e896bb8a6f825a2c85751b1d9e9d5843f10a84970db39102da
2a384b5d973b4ab543b633a54d3733d5a0735b8e010bd40cffb16b06eb6a634f
d8afb40c207e59ffafc237d43591839836e38cc0b377661d2a67e2ccc460665f
5f8965ddae318a039d7a395270f5fb28a0215317ae4fd404844ee01547c8bb80
f95b32b938cd1a7d3c43168266a870dc04c63bb3c5e327bac2c1a103758f3862
29cce708ecb7d1bfa2f1670bf79a78207599db4af44c98c567ee70afaca41011
f7d259a204a413158cd0f1021b25aa1e72e1b55c1f99b80a8727c13f5fb75847
2fc07d13a9511fb1afaaa84c3fdaef4f704e838fa7cb80d4a32c4e7a6834348f
78e8c1ef1a2c2bd30e3dbffc0dd80d2adf2ccd9fe87a27de08e33db5d14e2ba0
c6bd3f7ee5e9f6262696ed8e12393f2d55df705bf407579d889528dffa91b76e
fe25d618b9295233132f4bb1f938ffd1baccd26c917d4f3f5c54d929aaf64d5d
acb7685df19dd6841aa6cf02c4225567e6c9012dd32a51265cc822c40d2b3a75
158797f6ec79bd000d19dc1c43ba88f119c7e83d416e27ab1141ffff08d18b3e
ee127d4bc8b0bfe9a0e35db674a39ee1b1c719521f8badb6e8b6ca25da826ed4
cb941bcc4caa3551f402463c18c3ed31425a20ec669b010e2acaba4763133f32
`.trim().split(/\s+/));
const GRAPHIC_PRIMITIVES = new Set([
  "circle",
  "ellipse",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
]);

function usage() {
  console.log([
    "Usage:",
    "  node scripts/validate_native_ratp_svg.mjs [native.svg] [native.json] [--no-render] [--require-render]",
    "",
    "The default validation renders the SVG when Inkscape and ImageMagick are available.",
    "--no-render skips pixel and Inkscape bounding-box checks.",
    "--require-render fails instead of warning when either rendering tool is unavailable.",
  ].join("\n"));
}

function parseCli(argv) {
  const positional = [];
  let render = true;
  let requireRender = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--no-render") render = false;
    else if (argument === "--require-render") requireRender = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  if (positional.length > 2) throw new Error("Too many positional arguments");
  const svgFile = resolve(REPOSITORY_ROOT, positional[0] ?? DEFAULT_SVG);
  const jsonFile = resolve(
    REPOSITORY_ROOT,
    positional[1] ?? (positional[0] ? svgFile.replace(/\.svg$/i, ".json") : DEFAULT_JSON),
  );
  return { help: false, svgFile, jsonFile, render, requireRender };
}

let options;
try {
  options = parseCli(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(2);
}
if (options.help) {
  usage();
  process.exit(0);
}
for (const [label, file] of [["SVG", options.svgFile], ["JSON", options.jsonFile]]) {
  if (!existsSync(file)) {
    console.error(`${label} missing: ${relative(REPOSITORY_ROOT, file)}`);
    process.exit(1);
  }
}

function decodeXmlEntities(value, context) {
  return value.replace(/&([^;]+);/g, (entity, body) => {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' }[body];
    if (named !== undefined) return named;
    const numeric = body.startsWith("#x")
      ? Number.parseInt(body.slice(2), 16)
      : body.startsWith("#")
        ? Number.parseInt(body.slice(1), 10)
        : Number.NaN;
    if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff) {
      return String.fromCodePoint(numeric);
    }
    throw new Error(`Unknown or invalid XML entity ${entity} in ${context}`);
  });
}

function parseStartTag(source, position) {
  let cursor = 0;
  const attributes = Object.create(null);
  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  };
  const readName = () => {
    const match = source.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_.:-]*/);
    if (!match) throw new Error(`Invalid XML name at byte ${position + cursor}`);
    cursor += match[0].length;
    return match[0];
  };
  skipWhitespace();
  const name = readName();
  while (cursor < source.length) {
    skipWhitespace();
    if (cursor >= source.length) break;
    const attributeName = readName();
    if (Object.hasOwn(attributes, attributeName)) {
      throw new Error(`Duplicate attribute ${attributeName} on <${name}> at byte ${position}`);
    }
    skipWhitespace();
    if (source[cursor] !== "=") {
      throw new Error(`Attribute ${attributeName} on <${name}> has no '=' at byte ${position}`);
    }
    cursor += 1;
    skipWhitespace();
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Attribute ${attributeName} on <${name}> is not quoted at byte ${position}`);
    }
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) {
      throw new Error(`Unclosed attribute ${attributeName} on <${name}> at byte ${position}`);
    }
    const rawValue = source.slice(valueStart, valueEnd);
    if (rawValue.includes("<")) {
      throw new Error(`Illegal '<' in attribute ${attributeName} on <${name}> at byte ${position}`);
    }
    attributes[attributeName] = decodeXmlEntities(
      rawValue,
      `attribute ${attributeName} on <${name}>`,
    );
    cursor = valueEnd + 1;
  }
  return { name, attributes };
}

function findMarkupEnd(source, start) {
  let quote = null;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return cursor;
  }
  return -1;
}

function findDeclarationEnd(source, start) {
  let quote = null;
  let subsetDepth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") subsetDepth += 1;
    else if (character === "]") subsetDepth = Math.max(0, subsetDepth - 1);
    else if (character === ">" && subsetDepth === 0) return cursor;
  }
  return -1;
}

function parseXml(source) {
  const document = { children: [], text: [], name: "#document", attributes: {} };
  const nodes = [];
  const stack = [document];
  let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const appendText = (rawText, position) => {
    if (!rawText) return;
    const decoded = decodeXmlEntities(rawText, `text at byte ${position}`);
    if (stack.length === 1 && decoded.trim()) {
      throw new Error(`Text outside the root element at byte ${position}`);
    }
    stack.at(-1).text.push(decoded);
  };

  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening < 0) {
      appendText(source.slice(cursor), cursor);
      cursor = source.length;
      break;
    }
    appendText(source.slice(cursor, opening), cursor);
    if (source.startsWith("<!--", opening)) {
      const end = source.indexOf("-->", opening + 4);
      if (end < 0) throw new Error(`Unclosed XML comment at byte ${opening}`);
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", opening)) {
      const end = source.indexOf("]]>", opening + 9);
      if (end < 0) throw new Error(`Unclosed CDATA section at byte ${opening}`);
      stack.at(-1).text.push(source.slice(opening + 9, end));
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", opening)) {
      const end = source.indexOf("?>", opening + 2);
      if (end < 0) throw new Error(`Unclosed processing instruction at byte ${opening}`);
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", opening)) {
      const end = findDeclarationEnd(source, opening + 2);
      if (end < 0) throw new Error(`Unclosed declaration at byte ${opening}`);
      cursor = end + 1;
      continue;
    }

    const end = findMarkupEnd(source, opening + 1);
    if (end < 0) throw new Error(`Unclosed XML tag at byte ${opening}`);
    const rawMarkup = source.slice(opening + 1, end);
    if (rawMarkup.startsWith("/")) {
      const closingName = rawMarkup.slice(1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(closingName)) {
        throw new Error(`Invalid closing tag </${closingName}> at byte ${opening}`);
      }
      if (stack.length === 1) {
        throw new Error(`Unexpected closing tag </${closingName}> at byte ${opening}`);
      }
      const current = stack.at(-1);
      if (current.name !== closingName) {
        throw new Error(
          `Mismatched closing tag </${closingName}> at byte ${opening}; expected </${current.name}>`,
        );
      }
      stack.pop();
    } else {
      const selfClosing = /\/\s*$/.test(rawMarkup);
      const tagSource = selfClosing ? rawMarkup.replace(/\/\s*$/, "") : rawMarkup;
      const { name, attributes } = parseStartTag(tagSource, opening + 1);
      const parent = stack.at(-1);
      const node = {
        attributes,
        children: [],
        localName: name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name,
        name,
        parent,
        position: opening,
        text: [],
      };
      parent.children.push(node);
      nodes.push(node);
      if (!selfClosing) stack.push(node);
    }
    cursor = end + 1;
  }
  if (stack.length > 1) throw new Error(`Unclosed element <${stack.at(-1).name}>`);
  if (document.children.length !== 1) {
    throw new Error(`Expected exactly one XML root, found ${document.children.length}`);
  }
  return { nodes, root: document.children[0] };
}

function descendants(node) {
  const result = [];
  const pending = [...node.children];
  while (pending.length) {
    const candidate = pending.shift();
    result.push(candidate);
    pending.unshift(...candidate.children);
  }
  return result;
}

function classTokens(node) {
  return new Set((node.attributes.class ?? "").split(/\s+/).filter(Boolean));
}

function hasClass(node, className) {
  return classTokens(node).has(className);
}

function isDescendantOf(node, ancestor) {
  for (let current = node.parent; current && current.name !== "#document"; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function hasAncestorLocalName(node, names) {
  for (let current = node.parent; current && current.name !== "#document"; current = current.parent) {
    if (names.has(current.localName)) return true;
  }
  return false;
}

function styleMap(node) {
  const result = Object.create(null);
  for (const declaration of (node.attributes.style ?? "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const key = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function ownPresentation(node, property) {
  const styles = styleMap(node);
  return styles[property] ?? node.attributes[property];
}

function inheritedPresentation(node, property) {
  for (let current = node; current && current.name !== "#document"; current = current.parent) {
    const value = ownPresentation(current, property);
    if (value !== undefined && value !== "inherit") return value;
  }
  return undefined;
}

function numericPresentation(node, property, fallback = 1, multiplyAncestors = false) {
  if (multiplyAncestors) {
    let product = 1;
    for (let current = node; current && current.name !== "#document"; current = current.parent) {
      const value = ownPresentation(current, property);
      if (value === undefined || value === "inherit") continue;
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) product *= parsed;
    }
    return product;
  }
  const value = inheritedPresentation(node, property);
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hiddenByPresentation(node) {
  for (let current = node; current && current.name !== "#document"; current = current.parent) {
    const display = ownPresentation(current, "display")?.trim().toLowerCase();
    const visibility = ownPresentation(current, "visibility")?.trim().toLowerCase();
    if (display === "none" || visibility === "hidden" || visibility === "collapse") return true;
  }
  return numericPresentation(node, "opacity", 1, true) <= 0;
}

function paintIsVisible(node) {
  if (hiddenByPresentation(node)) return false;
  if (hasAncestorLocalName(node, new Set(["defs", "clipPath", "mask", "marker", "symbol"]))) {
    return false;
  }
  if (!GRAPHIC_PRIMITIVES.has(node.localName)) return false;
  if (node.localName === "path" && !/[A-Za-z]/.test(node.attributes.d ?? "")) return false;
  if (node.localName === "use") return Boolean(node.attributes.href ?? node.attributes["xlink:href"]);
  if (node.localName === "text") return true;
  const fill = (inheritedPresentation(node, "fill") ?? "black").trim().toLowerCase();
  const stroke = (inheritedPresentation(node, "stroke") ?? "none").trim().toLowerCase();
  const fillVisible = fill !== "none" && fill !== "transparent"
    && numericPresentation(node, "fill-opacity", 1, true) > 0;
  const strokeWidth = numericPresentation(node, "stroke-width", 1);
  const strokeVisible = stroke !== "none" && stroke !== "transparent" && strokeWidth > 0
    && numericPresentation(node, "stroke-opacity", 1, true) > 0;
  return fillVisible || strokeVisible;
}

function attr(node, names) {
  for (const name of names) {
    const value = node.attributes[name];
    if (value !== undefined && value.trim()) return value.trim();
  }
  return null;
}

function stationCode(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (/^IDFM:\d+$/.test(normalized)) return normalized;
  if (/^\d+$/.test(normalized)) return `IDFM:${normalized}`;
  return normalized;
}

function normalizedName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalPathSignature(node) {
  const attributes = node.attributes;
  const fields = [
    attributes.d ?? "",
    attributes.transform ?? "",
    attributes.fill ?? "",
    attributes.stroke ?? "",
    attributes["stroke-width"] ?? "",
    attributes["stroke-linecap"] ?? "",
    attributes["stroke-linejoin"] ?? "",
  ];
  return createHash("sha256").update(fields.join("\u001f")).digest("hex");
}

function hasNativeDecorationContext(node) {
  for (let current = node; current && current.name !== "#document"; current = current.parent) {
    const id = current.attributes.id ?? "";
    const classes = classTokens(current);
    if (id === "network-decorations" || id === "native-line-decorations") return true;
    if (classes.has("native-line-decoration") || classes.has("network-decoration")) return true;
  }
  return false;
}

function sourceWithNodeHidden(source, node) {
  const end = findMarkupEnd(source, node.position + 1);
  if (end < 0) throw new Error(`Cannot locate opening tag for #${node.attributes.id}`);
  const opening = source.slice(node.position, end + 1);
  const hidden = /\bdisplay\s*=/.test(opening)
    ? opening.replace(/\bdisplay\s*=\s*(["'])[^"']*\1/, 'display="none"')
    : opening.replace(/>$/, ' display="none">');
  return source.slice(0, node.position) + hidden + source.slice(end + 1);
}

function cropGeometry(box, width, height, scaleX, scaleY, padding = 6) {
  const x = Math.max(0, Math.floor(box.x * scaleX) - padding);
  const y = Math.max(0, Math.floor(box.y * scaleY) - padding);
  const right = Math.min(width, Math.ceil((box.x + box.width) * scaleX) + padding);
  const bottom = Math.min(height, Math.ceil((box.y + box.height) * scaleY) + padding);
  return `${Math.max(1, right - x)}x${Math.max(1, bottom - y)}+${x}+${y}`;
}

function simplePathBounds(node) {
  const pathData = node.attributes.d ?? "";
  if (!pathData || /[AHQSTV]/i.test(pathData)) return null;
  const numbers = (pathData.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  if (numbers.length < 4 || numbers.length % 2 !== 0 || !numbers.every(Number.isFinite)) return null;
  const transform = node.attributes.transform ?? "";
  let matrix = [1, 0, 0, 1, 0, 0];
  if (transform) {
    const values = transform.match(/^matrix\(([^)]+)\)$/)?.[1].split(/[\s,]+/).filter(Boolean).map(Number);
    if (!values || values.length !== 6 || !values.every(Number.isFinite)) return null;
    matrix = values;
  }
  const points = [];
  for (let index = 0; index < numbers.length; index += 2) {
    const [x, y] = [numbers[index], numbers[index + 1]];
    points.push({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] });
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  return { ...bounds, centerX: (bounds.minX + bounds.maxX) / 2, centerY: (bounds.minY + bounds.maxY) / 2 };
}

function objectValues(collection) {
  if (Array.isArray(collection)) return collection;
  if (collection && typeof collection === "object") {
    return Object.entries(collection).map(([key, value]) => (
      value && typeof value === "object" ? { __collectionKey: key, ...value } : value
    ));
  }
  return null;
}

function pathValue(object, path) {
  return path.reduce((value, key) => value?.[key], object);
}

function findCollection(document, kind) {
  const candidates = kind === "stations"
    ? [
      ["renderedMap", "stations"],
      ["renderedMap", "stationObjects"],
      ["renderedMap", "objects", "stations"],
      ["svgObjects", "stations"],
      ["objects", "stations"],
      ["index", "stations"],
      ["stations"],
    ]
    : [
      ["renderedMap", "interstations"],
      ["renderedMap", "interstationObjects"],
      ["renderedMap", "objects", "interstations"],
      ["svgObjects", "interstations"],
      ["objects", "interstations"],
      ["index", "interstations"],
      ["interstations"],
    ];
  for (const path of candidates) {
    const collection = objectValues(pathValue(document, path));
    if (collection) return { path: path.join("."), rows: collection };
  }
  return { path: null, rows: null };
}

function normalizeStationRow(row) {
  if (!row || typeof row !== "object") return { raw: row };
  let code = row.code ?? row.stationCode ?? row.stationId ?? row.id;
  if (String(code ?? "").startsWith("station-")) code = null;
  const svgId = row.svgId ?? row.svg?.id
    ?? (String(row.id ?? "").startsWith("station-") ? row.id : null);
  return {
    raw: row,
    code: stationCode(code),
    svgId,
    componentIds: row.visual?.componentIds
      ?? row.svgComponentIds
      ?? row.components?.componentIds
      ?? null,
    name: row.name ?? row.stationName ?? row.label ?? null,
    lines: row.lines ?? row.lineIds ?? null,
  };
}

function normalizeInterstationRow(row) {
  if (!row || typeof row !== "object") return { raw: row };
  const endpoints = row.stationCodes ?? row.stations ?? row.endpoints ?? [];
  const id = row.svgId ?? row.objectId ?? row.id ?? row.__collectionKey ?? null;
  return {
    raw: row,
    id,
    svgId: row.svgId ?? row.svg?.id ?? row.id ?? row.__collectionKey ?? null,
    lineId: row.lineId ?? row.lineCode ?? row.line ?? null,
    from: stationCode(
      row.fromStationCode ?? row.fromStationId ?? row.from ?? row.stationA ?? endpoints[0],
    ),
    to: stationCode(
      row.toStationCode ?? row.toStationId ?? row.to ?? row.stationB ?? endpoints[1],
    ),
  };
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return !result.error && result.status === 0;
}

function parseQueryAll(value) {
  const result = new Map();
  for (const row of value.split(/\r?\n/)) {
    const fields = row.split(",");
    if (fields.length < 5) continue;
    const numbers = fields.slice(-4).map(Number);
    const id = fields.slice(0, -4).join(",");
    if (id && numbers.every(Number.isFinite)) {
      result.set(id, { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] });
    }
  }
  return result;
}

function transparentPixel(value) {
  const normalized = value.trim().toLowerCase();
  if (/#[0-9a-f]{6}00\b/.test(normalized)) return true;
  const functional = normalized.match(/(?:s?rgba|graya?)\((.*)\)/);
  if (!functional) return false;
  const components = functional[1].split(",").map((component) => component.trim());
  const alpha = Number(components.at(-1));
  return Number.isFinite(alpha) && alpha === 0;
}

const failures = [];
const warnings = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const svgSource = readFileSync(options.svgFile, "utf8");
let jsonDocument;
try {
  jsonDocument = JSON.parse(readFileSync(options.jsonFile, "utf8"));
} catch (error) {
  console.error(`Invalid JSON in ${relative(REPOSITORY_ROOT, options.jsonFile)}: ${error.message}`);
  process.exit(1);
}
const repairedObjectModel = Boolean(jsonDocument.endpointRepair);
const declaredInterstationCount = jsonDocument.renderedMap?.interstationCount;
if (declaredInterstationCount !== undefined) {
  check(
    Number.isInteger(declaredInterstationCount) && declaredInterstationCount > 0,
    `JSON renderedMap.interstationCount must be a positive integer, found ${declaredInterstationCount}`,
  );
}
const expectedInterstationCount = Number.isInteger(declaredInterstationCount) && declaredInterstationCount > 0
  ? declaredInterstationCount
  : LEGACY_EXPECTED_INTERSTATIONS;
check(
  !repairedObjectModel || Number.isInteger(declaredInterstationCount),
  "A repaired object model must declare renderedMap.interstationCount",
);

let parsed;
try {
  parsed = parseXml(svgSource);
} catch (error) {
  console.error(`Invalid XML in ${relative(REPOSITORY_ROOT, options.svgFile)}: ${error.message}`);
  process.exit(1);
}
const { nodes, root } = parsed;
check(root.localName === "svg", `Root must be <svg>, found <${root.name}>`);
check(
  root.attributes.xmlns === "http://www.w3.org/2000/svg",
  'Root must declare xmlns="http://www.w3.org/2000/svg"',
);
check(root.attributes["data-background"] === "transparent", 'Root must declare data-background="transparent"');
const svgDeclaredInterstationCount = Number(root.attributes["data-interstation-count"]);
check(
  Number.isInteger(svgDeclaredInterstationCount) && svgDeclaredInterstationCount === expectedInterstationCount,
  `SVG data-interstation-count must equal manifest count ${expectedInterstationCount}, found ${root.attributes["data-interstation-count"] ?? "missing"}`,
);
for (const dimension of ["width", "height"]) {
  const match = (root.attributes[dimension] ?? "").match(/^([0-9]+(?:\.[0-9]+)?)mm$/i);
  check(Boolean(match) && Math.abs(Number(match?.[1]) - 400) < 1e-9, `${dimension} must be 400mm`);
}
const viewBox = (root.attributes.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
check(
  viewBox.length === 4 && viewBox.every(Number.isFinite)
    && viewBox.every((value, index) => Math.abs(value - EXPECTED_VIEW_BOX[index]) < 1e-6),
  `viewBox must be "${EXPECTED_VIEW_BOX.join(" ")}"`,
);

const idOwners = new Map();
for (const node of nodes) {
  const id = node.attributes.id;
  if (id === undefined) continue;
  check(Boolean(id.trim()), `<${node.name}> at byte ${node.position} has an empty id`);
  check(/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(id), `Invalid XML id "${id}"`);
  if (idOwners.has(id)) failures.push(`Duplicate XML id "${id}"`);
  else idOwners.set(id, node);
}

for (const node of nodes) {
  for (const [attribute, value] of Object.entries(node.attributes)) {
    const references = [];
    if (attribute === "href" || attribute === "xlink:href") {
      if (value.startsWith("#")) references.push(value.slice(1));
      else if (node.localName === "use") failures.push(`<use> at byte ${node.position} has an external href`);
    }
    for (const match of value.matchAll(/url\(\s*["']?#([^)'"\s]+)["']?\s*\)/g)) {
      references.push(match[1]);
    }
    if (attribute === "aria-labelledby" || attribute === "aria-describedby") {
      references.push(...value.split(/\s+/).filter(Boolean));
    }
    for (const reference of references) {
      check(idOwners.has(reference), `<${node.name}> ${attribute} references missing id "${reference}"`);
    }
  }
}

const forbiddenIds = ["official-ratp-artwork", "semantic-overlay", "page-background"];
for (const id of forbiddenIds) check(!idOwners.has(id), `Forbidden legacy/base group #${id} is present`);
const forbiddenClasses = new Set(["station-hit", "interstation-hit", "semantic-overlay"]);
for (const node of nodes) {
  for (const token of classTokens(node)) {
    check(!forbiddenClasses.has(token), `Forbidden overlay class .${token} is present`);
  }
}
check(!nodes.some((node) => node.localName === "image"), "Raster <image> elements are forbidden");

const backgroundOrLegend = /(?:^|[-_:])(background|page-background|legend|legende)(?:$|[-_:])/i;
for (const node of nodes) {
  const identifiers = [node.attributes.id, ...classTokens(node)].filter(Boolean);
  for (const identifier of identifiers) {
    check(!backgroundOrLegend.test(identifier), `Forbidden background/legend element "${identifier}" is present`);
  }
}
check(!svgSource.includes("M 1105.375 1105.339844"), "The large cream page background survives");
check(!svgSource.includes("M 950.328125 743.59375"), "The large white central background survives");
check(!svgSource.includes("M 168.640625 28.308594"), "The RATP logo/legend block survives");
const rootBackground = styleMap(root).background ?? styleMap(root)["background-color"];
check(
  rootBackground === undefined || /^(?:none|transparent)$/i.test(rootBackground),
  `Root CSS background must be transparent, found "${rootBackground}"`,
);
for (const node of nodes.filter((candidate) => candidate.localName === "rect")) {
  const width = Number(node.attributes.width);
  const height = Number(node.attributes.height);
  if (Number.isFinite(width) && Number.isFinite(height)
      && width >= EXPECTED_VIEW_BOX[2] * 0.95 && height >= EXPECTED_VIEW_BOX[3] * 0.95) {
    check(!paintIsVisible(node), `Visible near-page-size rectangle ${node.attributes.id ?? "without id"} is forbidden`);
  }
}

const waterways = nodes.filter((node) => node.localName === "g" && node.attributes.id === "waterways");
check(waterways.length === 1, `Exactly one #waterways group is required, found ${waterways.length}`);
let waterPrimitives = [];
if (waterways.length === 1) {
  waterPrimitives = descendants(waterways[0]).filter((node) => {
    const fill = (inheritedPresentation(node, "fill") ?? "").toUpperCase();
    const stroke = (inheritedPresentation(node, "stroke") ?? "").toUpperCase();
    return paintIsVisible(node) && (fill === WATER_COLOR || stroke === WATER_COLOR);
  });
  check(waterPrimitives.length > 0, `#waterways must paint at least one visible ${WATER_COLOR} primitive`);
}

const stationGroups = nodes.filter((node) => node.localName === "g" && hasClass(node, "station"));
const stationComponentGroups = nodes.filter(
  (node) => node.localName === "g" && hasClass(node, "station-component"),
);
const interstationGroups = nodes.filter((node) => node.localName === "g" && hasClass(node, "interstation"));
check(stationGroups.length === EXPECTED_STATIONS, `Expected ${EXPECTED_STATIONS} .station groups, found ${stationGroups.length}`);
check(
  interstationGroups.length === expectedInterstationCount,
  `Expected ${expectedInterstationCount} .interstation groups from manifest, found ${interstationGroups.length}`,
);

const nestedStationObjects = [...new Set([...stationGroups, ...stationComponentGroups])].filter((station) => (
  interstationGroups.some((interstation) => isDescendantOf(station, interstation))
));
const nestedInterstationObjects = interstationGroups.filter((interstation) => (
  stationGroups.some((station) => isDescendantOf(interstation, station))
));
check(
  nestedStationObjects.length === 0 && nestedInterstationObjects.length === 0,
  `Station and interstation objects must be disjoint siblings; nested objects: ${[
    ...nestedStationObjects, ...nestedInterstationObjects,
  ].map((node) => node.attributes.id).join(", ")}`,
);

const svgStationsByCode = new Map();
const svgStationsById = new Map();
for (const group of stationGroups) {
  const id = group.attributes.id;
  const code = stationCode(attr(group, ["data-station-code", "data-station-id", "data-code"]));
  const name = attr(group, ["data-name", "data-station-name"]);
  check(Boolean(id), `.station at byte ${group.position} needs an id`);
  check(hasClass(group, "native-station"), `.station ${id ?? `at byte ${group.position}`} needs class native-station`);
  check(Boolean(code), `.station ${id ?? `at byte ${group.position}`} needs a station code`);
  check(/^IDFM:\d+$/.test(code ?? ""), `.station ${id ?? "?"} has invalid station code "${code}"`);
  check(Boolean(name), `.station ${id ?? code ?? "?"} needs data-name`);
  if (id) {
    check(!svgStationsById.has(id), `Duplicate station SVG object id ${id}`);
    svgStationsById.set(id, group);
  }
  if (code) {
    check(!svgStationsByCode.has(code), `Duplicate station code ${code}`);
    svgStationsByCode.set(code, { group, id, code, name });
  }
  const primitives = descendants(group).filter(paintIsVisible);
  check(primitives.length > 0, `.station ${id ?? code ?? "?"} has no visible native primitive`);
  check(
    primitives.some((node) => hasClass(node, "native-source-primitive"))
      || primitives.some((node) => ["path", "use"].includes(node.localName)),
    `.station ${id ?? code ?? "?"} has no native path/use primitive`,
  );
  check(
    !descendants(group).some((node) => hiddenByPresentation(node) && GRAPHIC_PRIMITIVES.has(node.localName)),
    `.station ${id ?? code ?? "?"} contains hidden/invisible graphic primitives`,
  );
}

const centeredStationPaths = ({ x, y, tolerance, color = null }) => {
  const matches = [];
  for (const component of [...new Set([...stationGroups, ...stationComponentGroups])]) {
    const owner = stationCode(attr(component, ["data-station-code", "data-station-id", "data-code"]));
    for (const path of descendants(component).filter((node) => node.localName === "path" && paintIsVisible(node))) {
      const bounds = simplePathBounds(path);
      if (!bounds) continue;
      const paint = (inheritedPresentation(path, "fill") ?? inheritedPresentation(path, "stroke") ?? "").toUpperCase();
      if (color && paint !== color.toUpperCase()) continue;
      if (Math.hypot(bounds.centerX - x, bounds.centerY - y) <= tolerance) {
        matches.push({ owner, pathId: path.attributes.id, centerX: bounds.centerX, centerY: bounds.centerY });
      }
    }
  }
  return matches;
};

const targetedOwnership = {};
for (const target of [
  { key: "m11-mairie-des-lilas", code: "IDFM:71909", x: 987.277, y: 404.770, color: "#8D5E2A" },
  { key: "m11-serge-gainsbourg", code: "IDFM:490779", x: 1002.425, y: 393.910, color: "#8D5E2A" },
]) {
  const matches = centeredStationPaths({ ...target, tolerance: 0.4 });
  const owners = [...new Set(matches.map((match) => match.owner))];
  targetedOwnership[target.key] = { expectedOwner: target.code, owners, paths: matches.map((match) => match.pathId) };
  check(
    matches.length === 1 && owners.length === 1 && owners[0] === target.code,
    `${target.key} marker near (${target.x}, ${target.y}) must belong only to ${target.code}; found ${owners.join(", ") || "none"}`,
  );
}
const porteDeParisBubble = centeredStationPaths({ x: 574.99, y: 158.35, tolerance: 0.5 });
const porteDeParisBubbleOwners = [...new Set(porteDeParisBubble.map((match) => match.owner))];
targetedOwnership["t8-pole-bubble-574.99-158.35"] = { expectedOwner: "IDFM:72285", owners: porteDeParisBubbleOwners, paths: porteDeParisBubble.map((match) => match.pathId) };
check(
  porteDeParisBubble.length > 0 && porteDeParisBubbleOwners.length === 1 && porteDeParisBubbleOwners[0] === "IDFM:72285",
  `The T8 pole bubble near (574.99, 158.35) must belong uniquely to IDFM:72285; owners: ${porteDeParisBubbleOwners.join(", ") || "none"}`,
);

const svgInterstationsById = new Map();
const semanticTuples = new Map();
for (const group of interstationGroups) {
  const id = group.attributes.id;
  const lineId = attr(group, ["data-line-id", "data-line-code", "data-line"]);
  const from = stationCode(attr(group, ["data-from-station-code", "data-from-station-id", "data-from"]));
  const to = stationCode(attr(group, ["data-to-station-code", "data-to-station-id", "data-to"]));
  check(Boolean(id), `.interstation at byte ${group.position} needs an id`);
  check(
    hasClass(group, "native-interstation"),
    `.interstation ${id ?? `at byte ${group.position}`} needs class native-interstation`,
  );
  check(Boolean(lineId), `.interstation ${id ?? "?"} needs a line code`);
  check(/^IDFM:\d+$/.test(from ?? ""), `.interstation ${id ?? "?"} has invalid data-from "${from}"`);
  check(/^IDFM:\d+$/.test(to ?? ""), `.interstation ${id ?? "?"} has invalid data-to "${to}"`);
  check(Boolean(from && to && from !== to), `.interstation ${id ?? "?"} needs two distinct station codes`);
  if (group.attributes["data-object-id"] !== undefined) {
    check(group.attributes["data-object-id"] === id, `.interstation ${id ?? "?"} data-object-id differs from id`);
  }
  if (id) {
    check(!svgInterstationsById.has(id), `Duplicate interstation object id ${id}`);
    svgInterstationsById.set(id, { group, id, lineId, from, to });
  }
  if (lineId && from && to) {
    const tuple = `${lineId}|${[from, to].sort().join("|")}`;
    check(!semanticTuples.has(tuple), `Duplicate interstation tuple ${tuple}`);
    semanticTuples.set(tuple, id);
  }
  const paths = descendants(group).filter((node) => (
    node.localName === "path"
      && !stationComponentGroups.some((station) => isDescendantOf(node, station))
  ));
  const visiblePaths = paths.filter(paintIsVisible);
  check(paths.length > 0, `.interstation ${id ?? "?"} contains no path`);
  check(visiblePaths.length > 0, `.interstation ${id ?? "?"} contains no visible path`);
  check(paths.length === visiblePaths.length, `.interstation ${id ?? "?"} contains hidden/non-painting paths`);
  for (const path of visiblePaths) {
    check(Boolean(path.attributes.id), `.interstation ${id ?? "?"} has a path without id`);
    check(/[A-Za-z]/.test(path.attributes.d ?? ""), `${path.attributes.id ?? id ?? "Interstation path"} has empty path data`);
    const pathLength = Number(path.attributes.pathLength);
    check(Number.isFinite(pathLength) && Math.abs(pathLength - 1) < 1e-12, `${path.attributes.id ?? id ?? "Path"} needs pathLength="1"`);
    for (const [label, names, expected] of [
      ["line", ["data-line-id", "data-line-code", "data-line"], lineId],
      ["from", ["data-from-station-code", "data-from-station-id", "data-from"], from],
      ["to", ["data-to-station-code", "data-to-station-id", "data-to"], to],
    ]) {
      const value = attr(path, names);
      if (value !== null) {
        const normalized = label === "line" ? value : stationCode(value);
        check(normalized === expected, `${path.attributes.id ?? id} ${label} differs from its object group`);
      }
    }
  }
}

const survivingMonolithicRoutePaths = nodes.filter((node) => (
  node.localName === "path"
    && MONOLITHIC_ROUTE_SIGNATURES.has(canonicalPathSignature(node))
    && !interstationGroups.some((group) => isDescendantOf(node, group))
    && !hasNativeDecorationContext(node)
));
check(
  survivingMonolithicRoutePaths.length === 0,
  `Found ${survivingMonolithicRoutePaths.length} unsplit source Metro/RER path(s) outside .interstation objects: ${survivingMonolithicRoutePaths
    .map((node) => node.attributes.id ?? `byte ${node.position}`)
    .join(", ")}`,
);

const stationCollection = findCollection(jsonDocument, "stations");
const interstationCollection = findCollection(jsonDocument, "interstations");
check(Boolean(stationCollection.rows), "JSON has no rendered-map station collection");
check(Boolean(interstationCollection.rows), "JSON has no rendered-map interstation collection");
const jsonStations = (stationCollection.rows ?? []).map(normalizeStationRow);
const jsonInterstations = (interstationCollection.rows ?? []).map(normalizeInterstationRow);
check(jsonStations.length === stationGroups.length, `JSON ${stationCollection.path ?? "stations"} has ${jsonStations.length} rows; SVG has ${stationGroups.length}`);
check(
  jsonInterstations.length === interstationGroups.length,
  `JSON ${interstationCollection.path ?? "interstations"} has ${jsonInterstations.length} rows; SVG has ${interstationGroups.length}`,
);

const jsonStationsByCode = new Map();
const componentOwners = new Map();
for (const station of jsonStations) {
  check(Boolean(station.code), "A JSON station row has no explicit station code");
  check(Boolean(station.svgId), `JSON station ${station.code ?? "?"} has no svgId`);
  if (!station.code) continue;
  check(!jsonStationsByCode.has(station.code), `Duplicate JSON station code ${station.code}`);
  jsonStationsByCode.set(station.code, station);
  const svgStation = svgStationsByCode.get(station.code);
  check(Boolean(svgStation), `JSON station ${station.code} has no SVG .station object`);
  if (svgStation) {
    check(station.svgId === svgStation.id, `JSON station ${station.code} svgId ${station.svgId} != SVG id ${svgStation.id}`);
    if (station.name) {
      check(
        normalizedName(station.name) === normalizedName(svgStation.name),
        `JSON/SVG name mismatch for ${station.code}: "${station.name}" vs "${svgStation.name}"`,
      );
    }
  }
  if (station.componentIds !== null) {
    check(Array.isArray(station.componentIds), `JSON station ${station.code} componentIds must be an array`);
    if (Array.isArray(station.componentIds)) {
      check(station.componentIds.length > 0, `JSON station ${station.code} has an empty componentIds array`);
      check(station.componentIds.includes(station.svgId), `JSON station ${station.code} componentIds omits primary ${station.svgId}`);
      check(new Set(station.componentIds).size === station.componentIds.length, `JSON station ${station.code} has duplicate componentIds`);
      for (const componentId of station.componentIds) {
        check(typeof componentId === "string" && Boolean(componentId), `JSON station ${station.code} has an invalid componentId`);
        if (typeof componentId !== "string" || !componentId) continue;
        const component = idOwners.get(componentId);
        check(Boolean(component), `JSON station ${station.code} references missing component #${componentId}`);
        if (!component) continue;
        check(component.localName === "g", `Station component #${componentId} must be a <g>`);
        if (componentId === station.svgId) {
          check(hasClass(component, "station"), `Primary station component #${componentId} needs class station`);
        } else {
          check(hasClass(component, "station-component"), `Auxiliary station component #${componentId} needs class station-component`);
          check(!hasClass(component, "station"), `Auxiliary component #${componentId} must not carry class station`);
        }
        check(
          stationCode(attr(component, ["data-station-code", "data-station-id", "data-code"])) === station.code,
          `Station component #${componentId} has a mismatched data-station-code`,
        );
        check(
          descendants(component).some(paintIsVisible),
          `Station component #${componentId} contains no visible native primitive`,
        );
        check(!componentOwners.has(componentId), `Station component #${componentId} is referenced by multiple JSON stations`);
        componentOwners.set(componentId, station.code);
      }
    }
  }
}
for (const [code] of svgStationsByCode) {
  check(jsonStationsByCode.has(code), `SVG station ${code} is missing from JSON`);
}
if (jsonStations.some((station) => station.componentIds !== null)) {
  for (const component of stationComponentGroups) {
    check(componentOwners.has(component.attributes.id), `SVG station component #${component.attributes.id ?? "?"} is missing from JSON componentIds`);
  }
}

const jsonInterstationsById = new Map();
for (const interstation of jsonInterstations) {
  check(Boolean(interstation.id), "A JSON interstation row has no id/svgId");
  check(Boolean(interstation.svgId), `JSON interstation ${interstation.id ?? "?"} has no svgId`);
  check(Boolean(interstation.lineId), `JSON interstation ${interstation.id ?? "?"} has no line code`);
  check(Boolean(interstation.from), `JSON interstation ${interstation.id ?? "?"} has no from station code`);
  check(Boolean(interstation.to), `JSON interstation ${interstation.id ?? "?"} has no to station code`);
  if (!interstation.id) continue;
  check(!jsonInterstationsById.has(interstation.id), `Duplicate JSON interstation id ${interstation.id}`);
  jsonInterstationsById.set(interstation.id, interstation);
  const svgInterstation = svgInterstationsById.get(interstation.svgId ?? interstation.id);
  check(Boolean(svgInterstation), `JSON interstation ${interstation.id} has no SVG .interstation object`);
  if (svgInterstation) {
    check(interstation.svgId === svgInterstation.id, `JSON interstation ${interstation.id} has inconsistent svgId`);
    check(interstation.lineId === svgInterstation.lineId, `JSON/SVG line mismatch for ${interstation.id}`);
    check(interstation.from === svgInterstation.from, `JSON/SVG from mismatch for ${interstation.id}`);
    check(interstation.to === svgInterstation.to, `JSON/SVG to mismatch for ${interstation.id}`);
  }
}
for (const [id] of svgInterstationsById) {
  check(
    [...jsonInterstationsById.values()].some((row) => row.svgId === id),
    `SVG interstation ${id} is missing from JSON`,
  );
}
const crosswalkValidation = {
  required: repairedObjectModel,
  expectedSourceEdges: repairedObjectModel ? LEGACY_EXPECTED_INTERSTATIONS : null,
  entryCount: 0,
  uniqueOldIdCount: 0,
  renderedTargetCount: 0,
};
if (repairedObjectModel) {
  const crosswalk = jsonDocument.renderedMap?.topologyCrosswalk;
  check(Array.isArray(crosswalk), "A repaired object model must provide renderedMap.topologyCrosswalk");
  if (Array.isArray(crosswalk)) {
    const oldIds = new Set();
    const targetIds = new Set();
    const renderedIds = new Set(jsonInterstations.flatMap((row) => [row.id, row.svgId]).filter(Boolean));
    crosswalkValidation.entryCount = crosswalk.length;
    check(
      crosswalk.length === LEGACY_EXPECTED_INTERSTATIONS,
      `Endpoint-repair crosswalk must contain exactly ${LEGACY_EXPECTED_INTERSTATIONS} source edges, found ${crosswalk.length}`,
    );
    for (const [index, entry] of crosswalk.entries()) {
      const prefix = `Crosswalk entry ${index + 1}`;
      const validObject = entry && typeof entry === "object";
      check(validObject, `${prefix} must be an object`);
      if (!validObject) continue;
      check(typeof entry.oldId === "string" && Boolean(entry.oldId), `${prefix} needs a non-empty oldId`);
      if (typeof entry.oldId === "string" && entry.oldId) {
        check(!oldIds.has(entry.oldId), `Duplicate crosswalk oldId ${entry.oldId}`);
        oldIds.add(entry.oldId);
      }
      check(typeof entry.rendered === "boolean", `${prefix} must declare boolean rendered`);
      check(entry.newId === null || (typeof entry.newId === "string" && Boolean(entry.newId)), `${prefix} has invalid newId`);
      if (typeof entry.newId === "string" && entry.newId) {
        targetIds.add(entry.newId);
        check(renderedIds.has(entry.newId), `${prefix} targets missing rendered interstation ${entry.newId}`);
      }
      if (entry.rendered === true) check(typeof entry.newId === "string" && Boolean(entry.newId), `${prefix} is rendered but has no newId`);
      if (entry.newId === null) check(entry.rendered === false, `${prefix} has null newId but is marked rendered`);
      check(typeof entry.relation === "string" && Boolean(entry.relation), `${prefix} needs a relation`);
      check(typeof entry.reason === "string" && Boolean(entry.reason), `${prefix} needs a reason`);
    }
    crosswalkValidation.uniqueOldIdCount = oldIds.size;
    crosswalkValidation.renderedTargetCount = targetIds.size;
    check(
      oldIds.size === LEGACY_EXPECTED_INTERSTATIONS,
      `Endpoint-repair crosswalk must expose ${LEGACY_EXPECTED_INTERSTATIONS} unique oldIds, found ${oldIds.size}`,
    );
    for (const interstationId of new Set(jsonInterstations.map((row) => row.id).filter(Boolean))) {
      check(targetIds.has(interstationId), `Rendered interstation ${interstationId} has no topologyCrosswalk target`);
    }
  }
}


const m14Id = "interstation-M14-72126--72168";
const m14 = svgInterstationsById.get(m14Id);
check(Boolean(m14), `Required M14 reference object #${m14Id} is missing`);
if (m14) {
  check(m14.lineId === "M14", `${m14Id} must declare line M14`);
  check(
    new Set([m14.from, m14.to]).size === 2
      && [m14.from, m14.to].includes("IDFM:72126")
      && [m14.from, m14.to].includes("IDFM:72168"),
    `${m14Id} must connect IDFM:72126 to IDFM:72168`,
  );
  const paths = descendants(m14.group).filter((node) => node.localName === "path" && paintIsVisible(node));
  check(paths.length > 0, `${m14Id} must paint its actual purple line`);
  for (const path of paths) {
    const stroke = (inheritedPresentation(path, "stroke") ?? "").toUpperCase();
    const width = Number(inheritedPresentation(path, "stroke-width"));
    check(stroke === "#672583", `${path.attributes.id ?? m14Id} must use official M14 color #672583`);
    check(Number.isFinite(width) && Math.abs(width - 2.671) < 0.001, `${path.attributes.id ?? m14Id} must use M14 stroke-width 2.671`);
  }
}
for (const [code, expectedName] of [
  ["IDFM:72126", "Saint-Ouen"],
  ["IDFM:72168", "Mairie de Saint-Ouen"],
]) {
  const station = svgStationsByCode.get(code);
  check(Boolean(station), `Required M14 endpoint ${code} is missing`);
  if (station) {
    check(normalizedName(station.name) === normalizedName(expectedName), `${code} must be named "${expectedName}"`);
  }
}
check(
  [...jsonInterstationsById.values()].some((row) => row.svgId === m14Id),
  `JSON is missing the required M14 reference object ${m14Id}`,
);

const saintOuenObject = svgStationsById.get("station-72126");
check(
  saintOuenObject === svgStationsByCode.get("IDFM:72126")?.group,
  "Saint-Ouen must be the independently addressable SVG object #station-72126",
);

let renderSummary = { attempted: false, objectBoundsChecked: 0, transparentCorners: null, waterPixels: null, hiddenObjectDiffs: {} };
if (options.render) {
  const hasInkscape = commandAvailable("inkscape");
  const hasConvert = commandAvailable("convert");
  const hasCompare = commandAvailable("compare");
  if (!hasInkscape || !hasConvert || !hasCompare) {
    const message = `Render validation unavailable (inkscape=${hasInkscape}, convert=${hasConvert}, compare=${hasCompare})`;
    if (options.requireRender) failures.push(message);
    else warnings.push(message);
  } else {
    renderSummary.attempted = true;
    const workDirectory = mkdtempSync(join(tmpdir(), "ratp-native-validator-"));
    try {
      let boxes = new Map();
      const query = spawnSync("inkscape", [options.svgFile, "--query-all"], {
        encoding: "utf8",
        maxBuffer: 96 * 1024 * 1024,
        timeout: 180_000,
      });
      check(query.status === 0, `Inkscape --query-all failed: ${(query.stderr ?? "").trim()}`);
      if (query.status === 0) {
        boxes = parseQueryAll(query.stdout);
        for (const group of [...stationGroups, ...interstationGroups]) {
          const box = boxes.get(group.attributes.id);
          check(Boolean(box), `Inkscape reports no rendered bounds for #${group.attributes.id}`);
          if (box) {
            check(
              box.width > 0 || box.height > 0,
              `#${group.attributes.id} has zero rendered extent`,
            );
            renderSummary.objectBoundsChecked += 1;
          }
        }
      }

      const pngFile = join(workDirectory, "network.png");
      const render = spawnSync("inkscape", [
        options.svgFile,
        `--export-filename=${pngFile}`,
        "--export-width=512",
        "--export-height=512",
        "--export-background-opacity=0",
      ], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 180_000,
      });
      check(render.status === 0 && existsSync(pngFile), `Inkscape PNG render failed: ${(render.stderr ?? "").trim()}`);
      if (render.status === 0 && existsSync(pngFile)) {
        const corners = spawnSync("convert", [
          pngFile,
          "-format",
          "%[pixel:p{0,0}]|%[pixel:p{511,0}]|%[pixel:p{0,511}]|%[pixel:p{511,511}]",
          "info:",
        ], { encoding: "utf8", timeout: 30_000 });
        check(corners.status === 0, `ImageMagick corner-alpha query failed: ${(corners.stderr ?? "").trim()}`);
        if (corners.status === 0) {
          const pixels = corners.stdout.split("|");
          renderSummary.transparentCorners = pixels.filter(transparentPixel).length;
          check(
            pixels.length === 4 && pixels.every(transparentPixel),
            `All four rendered corners must be transparent; got ${corners.stdout}`,
          );
        }

        const histogram = spawnSync("convert", [pngFile, "-format", "%c", "histogram:info:-"], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60_000,
        });
        check(histogram.status === 0, `ImageMagick histogram failed: ${(histogram.stderr ?? "").trim()}`);
        if (histogram.status === 0) {
          let waterPixels = 0;
          for (const line of histogram.stdout.split(/\r?\n/)) {
            const match = line.match(/^\s*(\d+):.*#BBE3FA([0-9A-F]{2})?\b/i);
            if (match && (!match[2] || Number.parseInt(match[2], 16) > 0)) waterPixels += Number(match[1]);
          }
          renderSummary.waterPixels = waterPixels;
          check(waterPixels > 0, `Rendered PNG contains no ${WATER_COLOR} water pixels`);
        }

        const absoluteError = (left, right, label) => {
          const comparison = spawnSync("compare", ["-metric", "AE", left, right, "null:"], {
            encoding: "utf8",
            timeout: 60_000,
          });
          const validStatus = comparison.status === 0 || comparison.status === 1;
          check(validStatus, `${label} ImageMagick comparison failed: ${(comparison.stderr ?? "").trim()}`);
          if (!validStatus) return null;
          const match = (comparison.stderr ?? "").match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/i);
          const metric = Number(match?.[0]);
          check(Number.isFinite(metric), `${label} returned no finite AE pixel metric`);
          return Number.isFinite(metric) ? metric : null;
        };

        const renderHiddenObject = (id, node) => {
          const box = boxes.get(id);
          if (!node || !box) return;
          const variantSvg = join(workDirectory, `${id}-hidden.svg`);
          const variantPng = join(workDirectory, `${id}-hidden.png`);
          writeFileSync(variantSvg, sourceWithNodeHidden(svgSource, node), "utf8");
          const hiddenRender = spawnSync("inkscape", [
            variantSvg,
            `--export-filename=${variantPng}`,
            "--export-width=512",
            "--export-height=512",
            "--export-background-opacity=0",
          ], {
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 180_000,
          });
          check(
            hiddenRender.status === 0 && existsSync(variantPng),
            `Rendering the ${id} hidden variant failed: ${(hiddenRender.stderr ?? "").trim()}`,
          );
          if (hiddenRender.status !== 0 || !existsSync(variantPng)) return;

          const naturalPixels = 400 * 96 / 25.4;
          const geometry = cropGeometry(box, 512, 512, 512 / naturalPixels, 512 / naturalPixels);
          const originalCrop = join(workDirectory, `${id}-original-crop.png`);
          const hiddenCrop = join(workDirectory, `${id}-hidden-crop.png`);
          for (const [input, output] of [[pngFile, originalCrop], [variantPng, hiddenCrop]]) {
            const crop = spawnSync("convert", [input, "-crop", geometry, "+repage", output], {
              encoding: "utf8",
              timeout: 30_000,
            });
            check(crop.status === 0, `${id} crop failed: ${(crop.stderr ?? "").trim()}`);
          }
          if (!existsSync(originalCrop) || !existsSync(hiddenCrop)) return;
          const fullDifference = absoluteError(pngFile, variantPng, `${id} full render`);
          const croppedDifference = absoluteError(originalCrop, hiddenCrop, `${id} bbox render`);
          if (fullDifference === null || croppedDifference === null) return;
          check(fullDifference > 0, `Hiding #${id} changes no pixel; an identical base layer may remain underneath`);
          check(croppedDifference > 0, `Hiding #${id} changes no pixel inside its rendered bbox`);
          check(
            Math.abs(fullDifference - croppedDifference) < 0.5,
            `#${id} pixel changes escape its bbox (${fullDifference} total vs ${croppedDifference} cropped)`,
          );
          renderSummary.hiddenObjectDiffs[id] = {
            bbox: box,
            crop: geometry,
            changedPixels: fullDifference,
            changedPixelsInBbox: croppedDifference,
          };
        };

        renderHiddenObject(m14Id, m14?.group);
        renderHiddenObject("station-72126", saintOuenObject);
      }
    } finally {
      rmSync(workDirectory, { recursive: true, force: true });
    }
  }
}

if (failures.length) {
  console.error(`FAIL ${relative(REPOSITORY_ROOT, options.svgFile)}`);
  for (const failure of failures) console.error(`- ${failure}`);
  for (const warning of warnings) console.error(`WARN ${warning}`);
  console.error(`${failures.length} validation failure(s)`);
  process.exit(1);
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
console.log(`PASS ${relative(REPOSITORY_ROOT, options.svgFile)} native object model`);
console.log(JSON.stringify({
  svg: relative(REPOSITORY_ROOT, options.svgFile),
  json: relative(REPOSITORY_ROOT, options.jsonFile),
  stations: stationGroups.length,
  interstations: interstationGroups.length,
  expectedInterstations: expectedInterstationCount,
  objectModel: repairedObjectModel ? "endpoint-repaired" : "legacy-native",
  topologyCrosswalk: crosswalkValidation,
  waterways: waterways.length,
  visibleWaterPrimitives: waterPrimitives.length,
  legacyLayers: 0,
  overlayHitObjects: 0,
  images: 0,
  m14Reference: m14Id,
  targetedOwnership,
  monolithicRoutePaths: {
    referenceSignatureCount: MONOLITHIC_ROUTE_SIGNATURES.size,
    survivorsOutsideInterstations: survivingMonolithicRoutePaths.length,
  },
  jsonCollections: {
    stations: stationCollection.path,
    interstations: interstationCollection.path,
  },
  render: renderSummary,
}, null, 2));
