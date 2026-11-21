let idCounter = 0;

export function stringToIcon(value, _validate = false, allowSimpleNames = false) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name) return null;
  const colon = name.indexOf(":");
  if (colon < 1 || colon === name.length - 1) {
    return allowSimpleNames ? { prefix: "", name } : null;
  }
  return { prefix: name.slice(0, colon), name: name.slice(colon + 1) };
}

export function getIconData(icons, name) {
  if (!icons) return null;
  const direct = icons.icons?.[name];
  if (direct) return direct;
  const alias = icons.aliases?.[name];
  if (alias) return getIconData(icons, alias.parent);
  return null;
}

export function iconToSVG(icon, customisations = {}) {
  const ratio = icon.width && icon.height ? icon.width / icon.height : 1;
  let width = customisations.width;
  let height = customisations.height;
  if (width == null && height == null) height = "1em";
  if (width == null) width = typeof height === "number" ? height * ratio : "1em";
  if (height == null) height = typeof width === "number" ? width / ratio : "1em";
  return {
    attributes: {
      width,
      height,
      viewBox: `0 0 ${icon.width} ${icon.height}`,
      preserveAspectRatio: "xMidYMid meet"
    },
    body: icon.body
  };
}

export function iconToHTML(body, attributes) {
  const attrs = Object.entries(attributes)
    .filter(([, value]) => value != null)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
  return `<svg${attrs}>${body}</svg>`;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function replaceIDs(body) {
  const ids = new Set();
  for (const match of body.matchAll(/\b(?:id|xlink:href|href)\s*=\s*"([^"]+)"|url\(#([^)"']+)\)/g)) {
    const id = match[1] ?? match[2];
    if (id) ids.add(id);
  }
  let result = body;
  for (const id of ids) {
    const next = `biliscript-i${idCounter++}`;
    result = result
      .replace(new RegExp(`(\\bid\\s*=\\s*")${escapeRegExp(id)}(")`, "g"), `$1${next}$2`)
      .replace(new RegExp(`(\\bxlink:href\\s*=\\s*"#)${escapeRegExp(id)}(")`, "g"), `$1${next}$2`)
      .replace(new RegExp(`(\\bhref\\s*=\\s*"#)${escapeRegExp(id)}(")`, "g"), `$1${next}$2`)
      .replace(new RegExp(`url\\(#${escapeRegExp(id)}\\)`, "g"), `url(#${next})`);
  }
  return result;
}
