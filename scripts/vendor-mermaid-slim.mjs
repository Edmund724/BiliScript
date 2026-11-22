import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_TARGET } from "./build-guards.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "node_modules/mermaid/package.json");
const sourcePath = path.join(projectRoot, "node_modules/mermaid/dist/mermaid.core.mjs");
const outputPath = path.join(projectRoot, "node_modules/mermaid/dist/mermaid.biliscript.mjs");
const probeDir = path.join(projectRoot, ".scratch/mermaid-build");
const chunksSourceDir = path.join(projectRoot, "node_modules/mermaid/dist/chunks/mermaid.core");
const chunksOutputDir = path.join(projectRoot, "node_modules/mermaid/dist/chunks/mermaid.biliscript");
const iconifyStubPath = path.join(projectRoot, "scripts", "vendor-iconify-stub.mjs");
const markedStubPath = path.join(projectRoot, "scripts", "vendor-marked-stub.mjs");
const d3SlimPath = path.join(projectRoot, "scripts", "vendor-d3-slim.mjs");
const expectedVersion = "12.0.0";
const expectedSourceHash = "07703cb6ec75ac4a0d8b7224676a5a695977981cad8a1c9a82d785377c6ebe64";
const retainedTypes = [
  "flowchart-v2",
  "sequence"
];

const RECALIBRATION_HINT =
  "（若刚升级或更新过 mermaid，这是预期失败：按本文件头注的「版本锁与重校流程」重新校准）";

const ALLOWED_TRANSITION_CHAIN_ARITY = {
  duration: 1,
  style: 2,
  attr: 2,
  text: 1,
  html: 1,
  remove: 0
};

const REGEX_ALLOWED_BEFORE = new Set([
  "", "(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "^", "~",
  "+", "-", "*", "%", "<", ">", "return", "case", "throw", "in", "of",
  "typeof", "void", "delete", "new", "yield", "await", "=>", "else", "do"
]);

const ESCAPE_BEFORE_KEYWORDS = new Set(["return", "yield", "await", "throw"]);

const isIdStart = (ch) => /[a-zA-Z_$]/.test(ch);
const isIdPart = (ch) => /[a-zA-Z0-9_$]/.test(ch);

function stripD3SlimModule(src) {
  const banner = /^\/\/ [^\r\n]+$/gm;
  const markers = [...src.matchAll(banner)];
  if (markers.length === 0) return src;
  let out = src;
  for (let idx = markers.length - 1; idx >= 0; idx -= 1) {
    if (markers[idx][0].trim() !== "// scripts/vendor-d3-slim.mjs") continue;
    const start = markers[idx].index;
    const end = idx + 1 < markers.length ? markers[idx + 1].index : out.length;
    const preservedNewlines = out.slice(start, end).replace(/[^\n]/g, "");
    out = out.slice(0, start) + preservedNewlines + out.slice(end);
  }
  return out;
}

function buildCodeMask(src) {
  const n = src.length;
  const mask = new Uint8Array(n);
  let i = 0;
  let prevToken = "";
  const tplStack = [];

  const markRange = (from, to) => {
    for (let k = from; k < to; k += 1) mask[k] = 1;
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      mask[i] = 1;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      if (i < n) i += 2;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      const quote = ch;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        i += 1;
      }
      if (i < n) i += 1;
      prevToken = "str";
      continue;
    }

    if (ch === "`") {
      i += 1;
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "`") {
          i += 1;
          closed = true;
          break;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          tplStack.push(0);
          i += 2;
          prevToken = "{";
          break;
        }
        i += 1;
      }
      if (closed) prevToken = "str";
      continue;
    }

    if (ch === "{" && tplStack.length > 0) {
      tplStack[tplStack.length - 1] += 1;
      mask[i] = 1;
      i += 1;
      prevToken = "{";
      continue;
    }

    if (ch === "}" && tplStack.length > 0) {
      if (tplStack[tplStack.length - 1] === 0) {
        tplStack.pop();
        i += 1;
        let closed = false;
        while (i < n) {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === "`") {
            i += 1;
            closed = true;
            break;
          }
          if (src[i] === "$" && src[i + 1] === "{") {
            tplStack.push(0);
            i += 2;
            prevToken = "{";
            break;
          }
          i += 1;
        }
        if (closed) prevToken = "str";
        continue;
      }
      tplStack[tplStack.length - 1] -= 1;
      mask[i] = 1;
      i += 1;
      prevToken = "}";
      continue;
    }

    if (ch === "/" && REGEX_ALLOWED_BEFORE.has(prevToken)) {
      const scanStart = i;
      i += 1;
      let inClass = false;
      let validRegex = false;
      while (i < n && src[i] !== "\n" && src[i] !== "\r") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") {
          inClass = true;
          i += 1;
          continue;
        }
        if (src[i] === "]") {
          inClass = false;
          i += 1;
          continue;
        }
        if (src[i] === "/" && !inClass) {
          i += 1;
          validRegex = true;
          break;
        }
        i += 1;
      }
      if (validRegex) {
        while (i < n && /[a-zA-Z]/.test(src[i])) i += 1;
        prevToken = "regex";
        continue;
      }
      i = scanStart;
    }

    if (isIdStart(ch)) {
      const start = i;
      i += 1;
      while (i < n && isIdPart(src[i])) i += 1;
      markRange(start, i);
      prevToken = src.slice(start, i);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < n && /[0-9a-zA-Z_.]/.test(src[i])) i += 1;
      markRange(start, i);
      prevToken = "num";
      continue;
    }

    if (ch === "=" && next === ">") {
      markRange(i, i + 2);
      i += 2;
      prevToken = "=>";
      continue;
    }

    mask[i] = 1;
    i += 1;
    prevToken = ch;
  }

  return mask;
}

function lineNumberAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (src[i] === "\n") line += 1;
  }
  return line;
}

function skipForwardTrivia(src, mask, pos) {
  const n = src.length;
  let i = pos;
  while (i < n && (mask[i] === 0 || src[i] === " " || src[i] === "\t" || src[i] === "\r" || src[i] === "\n")) {
    i += 1;
  }
  return i;
}

function skipForwardInlineTrivia(src, mask, pos) {
  const n = src.length;
  let i = pos;
  while (i < n && (mask[i] === 0 || src[i] === " " || src[i] === "\t")) {
    if (src[i] === "\n" || src[i] === "\r") break;
    i += 1;
  }
  return i;
}

function skipBackwardTrivia(src, mask, pos) {
  let i = pos;
  while (i >= 0 && (mask[i] === 0 || src[i] === " " || src[i] === "\t" || src[i] === "\r" || src[i] === "\n")) {
    i -= 1;
  }
  return i;
}

function parseCallArgs(src, mask, openParenIndex) {
  const n = src.length;
  let depth = 0;
  let i = openParenIndex;
  let argCount = 0;
  let hasContentInCurrentArg = false;

  while (i < n) {
    if (mask[i] === 1) {
      const ch = src[i];
      if (ch === "(" || ch === "[" || ch === "{") {
        if (depth >= 1) hasContentInCurrentArg = true;
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) {
          if (hasContentInCurrentArg) argCount += 1;
          return { endIndex: i + 1, argCount };
        }
      } else if (ch === "," && depth === 1) {
        if (hasContentInCurrentArg) {
          argCount += 1;
          hasContentInCurrentArg = false;
        }
      } else if (depth === 1 && !/\s/.test(ch)) {
        hasContentInCurrentArg = true;
      }
    } else if (depth === 1) {
      const ch = src[i];
      if (ch === "'" || ch === "\"" || ch === "`" || (ch === "/" && src[i + 1] !== "/" && src[i + 1] !== "*")) {
        hasContentInCurrentArg = true;
      }
    }
    i += 1;
  }
  return null;
}

function doesReceiverEscape(src, mask, dotIndex) {
  let i = skipBackwardTrivia(src, mask, dotIndex - 1);
  if (i >= 0 && src[i] === "?") {
    i = skipBackwardTrivia(src, mask, i - 1);
  }
  while (i >= 0) {
    i = skipBackwardTrivia(src, mask, i);
    if (i < 0) break;
    const ch = src[i];
    if (ch === ")" || ch === "]") {
      const closeCh = ch;
      const openCh = ch === ")" ? "(" : "[";
      let depth = 1;
      i -= 1;
      while (i >= 0 && depth > 0) {
        if (mask[i] === 1) {
          if (src[i] === closeCh) depth += 1;
          else if (src[i] === openCh) depth -= 1;
        }
        i -= 1;
      }
      continue;
    }
    if (isIdPart(ch)) {
      while (i >= 0 && mask[i] === 1 && isIdPart(src[i])) i -= 1;
      const beforeId = skipBackwardTrivia(src, mask, i);
      if (beforeId >= 0 && src[beforeId] === ".") {
        i = beforeId - 1;
        if (i >= 0 && mask[i] === 1 && src[i] === "?") i -= 1;
        continue;
      }
      break;
    }
    break;
  }

  const prev = skipBackwardTrivia(src, mask, i);
  if (prev < 0) return false;
  const ch = src[prev];
  if (ch === "=" || ch === "(" || ch === "[" || ch === "," || ch === ":" || ch === "?") {
    return true;
  }
  if (ch === ">" && prev > 0 && mask[prev - 1] === 1 && src[prev - 1] === "=") {
    return true;
  }
  if (isIdPart(ch)) {
    let start = prev;
    while (start >= 0 && mask[start] === 1 && isIdPart(src[start])) start -= 1;
    const word = src.slice(start + 1, prev + 1);
    if (ESCAPE_BEFORE_KEYWORDS.has(word)) {
      return true;
    }
  }
  return false;
}

export function auditMermaidTransitionCalls(rawSource, sourceLabel = "<memory>") {
  const src = stripD3SlimModule(rawSource);
  const mask = buildCodeMask(src);
  const n = src.length;
  const calls = [];
  const violations = [];

  for (let i = 0; i < n; i += 1) {
    if (mask[i] !== 1 || src[i] !== ".") continue;
    if ((i > 0 && mask[i - 1] === 1 && src[i - 1] === ".") || (i + 1 < n && mask[i + 1] === 1 && src[i + 1] === ".")) {
      continue;
    }
    const idStart = skipForwardTrivia(src, mask, i + 1);
    if (idStart >= n || !isIdStart(src[idStart])) continue;
    let idEnd = idStart + 1;
    while (idEnd < n && mask[idEnd] === 1 && isIdPart(src[idEnd])) idEnd += 1;
    const methodName = src.slice(idStart, idEnd);
    if (methodName !== "transition" && methodName !== "interrupt") continue;
    const parenIdx = skipForwardTrivia(src, mask, idEnd);
    if (parenIdx >= n || mask[parenIdx] !== 1 || src[parenIdx] !== "(") continue;

    const line = lineNumberAt(src, i);
    if (methodName === "interrupt") {
      violations.push(`${sourceLabel}:${line}: 检测到 .interrupt() 调用（vendor-d3-slim 不支持）`);
      continue;
    }

    const transitionArgs = parseCallArgs(src, mask, parenIdx);
    if (!transitionArgs) {
      violations.push(`${sourceLabel}:${line}: 无法解析 .transition(...) 参数列表`);
      continue;
    }
    if (doesReceiverEscape(src, mask, i)) {
      violations.push(`${sourceLabel}:${line}: transition() 返回值可能逃逸（禁止赋值/返回/传参脱离静态审计链）`);
    }
    if (transitionArgs.argCount > 0) {
      violations.push(`${sourceLabel}:${line}: transition() 含 ${transitionArgs.argCount} 个参数（具名或继承过渡不受支持）`);
    }

    let cursor = transitionArgs.endIndex;
    const chainMethods = [];
    let abortedChain = false;

    while (cursor < n) {
      const nextPos = skipForwardTrivia(src, mask, cursor);
      if (nextPos >= n) break;
      let dotPos = -1;
      if (src[nextPos] === ".") {
        dotPos = nextPos;
      } else if (src[nextPos] === "?" && nextPos + 1 < n && mask[nextPos + 1] === 1 && src[nextPos + 1] === ".") {
        dotPos = nextPos + 1;
      } else {
        break;
      }
      const mStart = skipForwardTrivia(src, mask, dotPos + 1);
      if (mStart >= n || !isIdStart(src[mStart])) {
        violations.push(`${sourceLabel}:${line}: transition 链后出现无法解析的成员访问`);
        abortedChain = true;
        break;
      }
      let mEnd = mStart + 1;
      while (mEnd < n && mask[mEnd] === 1 && isIdPart(src[mEnd])) mEnd += 1;
      const chainedName = src.slice(mStart, mEnd);
      const callParen = skipForwardTrivia(src, mask, mEnd);
      if (callParen >= n || mask[callParen] !== 1 || src[callParen] !== "(") {
        violations.push(`${sourceLabel}:${line}: transition 链访问了非调用成员 .${chainedName}`);
        abortedChain = true;
        break;
      }
      const callArgs = parseCallArgs(src, mask, callParen);
      if (!callArgs) {
        violations.push(`${sourceLabel}:${line}: 无法解析 transition.${chainedName}(...) 参数列表`);
        abortedChain = true;
        break;
      }
      chainMethods.push(chainedName);
      if (!Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITION_CHAIN_ARITY, chainedName)) {
        violations.push(`${sourceLabel}:${line}: transition 链调用了未允许方法 .${chainedName}()`);
      } else {
        const minArgs = ALLOWED_TRANSITION_CHAIN_ARITY[chainedName];
        if (callArgs.argCount < minArgs) {
          violations.push(
            `${sourceLabel}:${line}: transition.${chainedName}() 参数不足（需至少 ${minArgs} 个，实际 ${callArgs.argCount} 个）`
          );
        }
      }
      cursor = callArgs.endIndex;
    }

    if (!abortedChain) {
      if (chainMethods.length === 0) {
        violations.push(`${sourceLabel}:${line}: transition() 后缺少已允许的终态写入链`);
      }
      const afterChain = skipForwardInlineTrivia(src, mask, cursor);
      if (afterChain < n) {
        const term = src[afterChain];
        if (term !== ";" && term !== "}" && term !== "\n" && term !== "\r") {
          violations.push(`${sourceLabel}:${line}: transition 链后紧跟 "${term}"，未以独立语句结束（可能逃逸或动态访问）`);
        }
      }
    }

    calls.push({ source: sourceLabel, line, methods: chainMethods });
    i = Math.max(i, cursor - 1);
  }

  return { calls, violations };
}

async function buildMermaidSlim() {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (pkg.version !== expectedVersion) {
    throw new Error(`Expected Mermaid ${expectedVersion}, got ${pkg.version}${RECALIBRATION_HINT}`);
  }

  const source = fs.readFileSync(sourcePath, "utf8");
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  if (sourceHash !== expectedSourceHash) {
    throw new Error(`Unexpected Mermaid source hash: ${sourceHash}${RECALIBRATION_HINT}`);
  }

  const findChunkByContent = (anchor) => {
    const hits = fs
      .readdirSync(chunksSourceDir)
      .filter((name) => name.endsWith(".mjs"))
      .filter((name) => fs.readFileSync(path.join(chunksSourceDir, name), "utf8").includes(anchor));
    if (hits.length !== 1) {
      throw new Error(
        `Mermaid chunk lookup by "${anchor}" matched ${hits.length} files: ${hits.join(", ") || "(none)"}${RECALIBRATION_HINT}`
      );
    }
    return hits[0];
  };
  const layoutChunkName = findChunkByContent("registerDefaultLayoutLoaders");
  const mathChunkName = findChunkByContent('await import("katex")');

  const sourceMarkers = [...source.matchAll(/^\/\/ src\/[^\n]+$/gm)];
  const detectorMarkers = [...source.matchAll(/^\/\/ src\/diagrams\/[^\n]*[dD]etector[^/]*\.ts$/gm)];
  const declarations = new Map();
  const segments = detectorMarkers.map((marker, index) => {
    const start = marker.index;
    const end = sourceMarkers.find((candidate) => candidate.index > start)?.index ?? source.length;
    const segment = source.slice(start, end);
    const idMatch = /^var\s+(id\d*)\s*=\s*"([^"]+)";$/m.exec(segment);
    const pluginMatch = /^var\s+(\w+)\s*=\s*\{[\s\S]*?^\};$/m.exec(segment);
    if (!idMatch || !pluginMatch) {
      throw new Error(`Unable to parse Mermaid detector declaration at offset ${start}`);
    }
    const tail = segment.slice(pluginMatch.index + pluginMatch[0].length);
    const exportMatch = /^var\s+(\w+)\s*=\s*(\w+);$/m.exec(tail);
    const type = idMatch[2];
    const plugin = pluginMatch[1];
    const declaration = {
      type,
      idVariable: idMatch[1],
      plugin,
      exportName: exportMatch?.[1] ?? null,
      start,
      end,
      order: index
    };
    if (declarations.has(type) || [...declarations.values()].some((item) => item.plugin === plugin)) {
      throw new Error(`Duplicate Mermaid detector declaration: ${type}`);
    }
    if (exportMatch && exportMatch[2] !== plugin) {
      throw new Error(`Mermaid export for ${type} does not reference its plugin`);
    }
    declarations.set(type, declaration);
    return declaration;
  });

  for (const type of retainedTypes) {
    const declaration = declarations.get(type);
    if (!declaration?.exportName) {
      throw new Error(`Missing retained Mermaid detector declaration: ${type}`);
    }
  }

  const registrationBlock = /if \(true\) \{\s*registerLazyLoadedDiagrams\(([^;]*)\);\s*\}\s*registerLazyLoadedDiagrams\(([\s\S]*?)\);/;
  const registrationMatch = registrationBlock.exec(source);
  if (!registrationMatch) {
    throw new Error("Mermaid diagram registration layout changed");
  }
  const parseRegistration = (text) => text.split(",").map((name) => name.trim());
  const originalFast = parseRegistration(registrationMatch[1]);
  const originalAll = parseRegistration(registrationMatch[2]);
  const isKnownRegistration = (name) => [...declarations.values()].some((declaration) =>
    declaration.plugin === name || declaration.exportName === name
  );
  for (const plugin of [...originalFast, ...originalAll]) {
    if (!isKnownRegistration(plugin)) {
      throw new Error(`Registration references an unknown Mermaid plugin: ${plugin}`);
    }
  }

  const isRetainedExport = (name) => retainedTypes.some((type) => declarations.get(type)?.exportName === name);
  const nextFast = originalFast.filter(isRetainedExport);
  const nextAll = originalAll.filter(isRetainedExport);
  const registrationReplacement = `if (true) {\n    registerLazyLoadedDiagrams(${nextFast.join(", ")});\n  }\n  registerLazyLoadedDiagrams(${nextAll.join(", ")});`;
  let generated = `${source.slice(0, registrationMatch.index)}${registrationReplacement}${source.slice(registrationMatch.index + registrationMatch[0].length)}`;
  const retainedSet = new Set(retainedTypes);
  for (const segment of segments.toReversed()) {
    if (!retainedSet.has(segment.type)) {
      generated = generated.slice(0, segment.start) + generated.slice(segment.end);
    }
  }
  if (generated === source || generated.length >= source.length) {
    throw new Error("Mermaid detector trimming made no change");
  }

  fs.rmSync(chunksOutputDir, { recursive: true, force: true });
  fs.cpSync(chunksSourceDir, chunksOutputDir, {
    recursive: true,
    filter: (entry) => entry === chunksSourceDir || entry.endsWith(".mjs")
  });
  const chunkPrefixOriginal = "./chunks/mermaid.core/";
  const chunkPrefixPatched = "./chunks/mermaid.biliscript/";
  if (!generated.includes(chunkPrefixOriginal)) {
    throw new Error("Mermaid entry does not reference its chunk directory");
  }
  generated = generated.split(chunkPrefixOriginal).join(chunkPrefixPatched);

  const layoutChunkPatched = path.join(chunksOutputDir, layoutChunkName);
  const mathChunkPatched = path.join(chunksOutputDir, mathChunkName);

  const replaceOnce = (text, pattern, replacement, label) => {
    const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))];
    if (matches.length !== 1) {
      throw new Error(`Mermaid trim target "${label}" matched ${matches.length} times${RECALIBRATION_HINT}`);
    }
    const next = text.replace(pattern, replacement);
    if (next === text) {
      throw new Error(`Mermaid trim target "${label}" matched but replacement made no change${RECALIBRATION_HINT}`);
    }
    return next;
  };

  let layoutChunkText = fs.readFileSync(layoutChunkPatched, "utf8");
  layoutChunkText = replaceOnce(
    layoutChunkText,
    /^[ \t]*\{\s*name: "swimlane",[^{}]*?\},\r?\n/m,
    "",
    "swimlane loader entry"
  );

  layoutChunkText = replaceOnce(
    layoutChunkText,
    /\.\.\.true \? \[[\s\S]*?\] : \[\]/,
    "...[]",
    "cose-bilkent loader spread"
  );

  layoutChunkText = replaceOnce(
    layoutChunkText,
    /^var elkLayoutLoaders = [\s\S]*?\}, "elkLayoutLoaders"\);\r?\n/m,
    "",
    "elkLayoutLoaders declaration"
  );
  layoutChunkText = replaceOnce(
    layoutChunkText,
    /(?:\/\/ src\/rendering-util\/layout-algorithms\/elk\/algorithms\.ts\r?\n)?var ELK_ALGORITHMS = \[[^\]]*\];\r?\n\r?\n?/,
    "",
    "ELK_ALGORITHMS declaration"
  );
  fs.writeFileSync(layoutChunkPatched, layoutChunkText);

  const katexBlockPattern = / {2}if \(true\) \{\r?\n {4}const \{ default: katex \} = await import\("katex"\);[\s\S]*? {2}return text\.replace\(\r?\n {4}katexRegex,\r?\n {4}"Katex is not supported in @mermaid-js\/tiny\. Please use the full mermaid library\."\r?\n {2}\);/;
  const katexBlockReplacement = `  return text.replace(
    katexRegex,
    "MathML is unsupported in this environment."
  );`;
  let mathChunkText = fs.readFileSync(mathChunkPatched, "utf8");
  mathChunkText = replaceOnce(mathChunkText, katexBlockPattern, katexBlockReplacement, "katex block");
  if (mathChunkText.includes('await import("katex")') || mathChunkText.includes("@mermaid-js/tiny")) {
    throw new Error(`Mermaid katex trim incomplete in math chunk${RECALIBRATION_HINT}`);
  }
  fs.writeFileSync(mathChunkPatched, mathChunkText);

  fs.writeFileSync(outputPath, generated);

  fs.rmSync(probeDir, { recursive: true, force: true });
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [outputPath],
    outdir: probeDir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: BUILD_TARGET,
    alias: {
      "@iconify/utils": iconifyStubPath,
      marked: markedStubPath,
      d3: d3SlimPath
    },
    metafile: true
  });
  for (const stubPath of [markedStubPath, d3SlimPath]) {
    const stubName = path.basename(stubPath);
    if (!Object.keys(result.metafile.inputs).some((input) => input.endsWith(stubName))) {
      throw new Error(`Mermaid slim alias did not apply: ${stubName} not in probe inputs`);
    }
  }
  const outputNames = Object.keys(result.metafile.outputs);
  for (const retained of ["flowDiagram", "sequenceDiagram", "dagre"]) {
    if (!outputNames.some((name) => name.includes(retained))) {
      throw new Error(`Retained output is missing: ${retained}`);
    }
  }
  for (const excluded of ["architecture", "c4Diagram", "pieDiagram", "gitGraph", "journeyDiagram", "quadrantDiagram", "xychartDiagram", "requirementDiagram", "sankeyDiagram", "blockDiagram", "vennDiagram", "railroadDiagram", "erDiagram", "ganttDiagram", "stateDiagram", "swimlanes", "katex", "elk", "mindmap", "cose-bilkent", "classDiagram", "agentflow", "usecase"]) {
    if (outputNames.some((name) => name.includes(excluded))) {
      throw new Error(`Excluded output remains: ${excluded}${RECALIBRATION_HINT}`);
    }
  }
  const auditedCalls = [];
  const transitionViolations = [];
  for (const name of outputNames) {
    if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
    const text = fs.readFileSync(name, "utf8");
    const { calls, violations } = auditMermaidTransitionCalls(text, path.relative(projectRoot, name));
    auditedCalls.push(...calls);
    transitionViolations.push(...violations);
  }
  if (transitionViolations.length > 0) {
    throw new Error(
      `Mermaid d3-transition closure audit failed:\n  ${transitionViolations.join("\n  ")}${RECALIBRATION_HINT}`
    );
  }
  const totalBytes = outputNames.reduce((sum, name) => sum + fs.statSync(name).size, 0);
  console.log(
    `Mermaid slim check: ${outputNames.length} probe files, ${totalBytes} bytes, ${auditedCalls.length} audited transition call(s)`
  );
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  await buildMermaidSlim();
}
